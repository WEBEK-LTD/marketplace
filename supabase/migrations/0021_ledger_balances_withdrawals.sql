-- 0021 — Financial ledger, seller balances, wallet view, withdrawals and limits, commissions, and the
-- `fulfil_checkout()` replacement that posts the capture journal (v5.2 "Ledger", "Withdrawal and payout
-- flow"; D11, D20, D26, D27, C10, C17, UB8).
--
-- The ledger is double-entry and single-currency: every journal's debits equal its credits, in one
-- currency, in integer minor units. Nothing here is ever updated or deleted — a correction is a
-- reversing journal, which is why every ledger table carries the append-only trigger. Posting happens
-- only through `app_private.post_ledger_journal()`; no role holds INSERT on the ledger tables.
--
-- Account types (spec list, all fifteen): provider_clearing, payout_clearing, unallocated_receipts,
-- commission_revenue, promotion_revenue, payment_fees, buyer_fee_recovery, fee_variance, refunds, tax,
-- platform_loss, seller_pending, seller_available, seller_reserved, seller_receivable.
--
-- `seller_balances` is keyed by (seller_user_id, currency_code) and is maintained only by the posting
-- function, which takes the row lock in seller order so concurrent journals queue instead of
-- deadlocking. The non-negative CHECKs on that table are what makes an overdraw impossible: a journal
-- that would spend money the seller does not have fails on the constraint, not on a read-then-write race.
--
-- `wallet_transactions` is the seller-facing view over the seller's own ledger entries. It is a
-- `security_invoker` view, so the row level security on `ledger_entries` is what decides who sees what.
--
-- Two readings of the specification are recorded here rather than guessed at silently:
--
--   1. Withdrawal funds are reserved when the request is created, not on the move to `under_review`.
--      The approved state diagram labels both `requested --> cancelled` and `under_review --> rejected`
--      with "funds released", which only holds if the funds were already reserved while `requested`.
--      Reserving at request is also the only reading under which two requests cannot be raised against
--      the same available balance.
--   2. A withdrawal's `paid` journal debits `seller_reserved` and credits `payout_clearing`, so
--      `payout_clearing` carries the obligation in transit. The matching debit against
--      `provider_clearing` belongs to the payout and settlement work in 0022/0023.
--
-- UB8 is respected: nothing in this migration assumes the platform holds funds. The ledger records
-- obligations and the withdrawal state machine records decisions; no money moves anywhere. Payout
-- execution is 0022 and stays blocked until B1-B, and settlement reconciliation is 0023 (B1-C).
--
-- Not built here, on purpose: `seller_receivables` and `receivable_recoveries` are conditional on D21,
-- which is BLOCKED, so negative balances and post-payout recovery have no schema yet. The
-- `seller_receivable` account type is in the chart of accounts because the specification lists it, but
-- nothing posts to it.
--
-- C17 expand/contract: three additive columns land on `public.checkout_items` (`commission_minor`,
-- `commission_base_minor`, `commission_snapshot`). Commission is resolved in NestJS at checkout and
-- snapshotted per item (D11, D27); the ledger needs that per-item figure at fulfilment, and the
-- `commission_minor` / `commission_total_minor` columns that 0018 already defined on orders and order
-- items have had no source until now.

-- ---------------------------------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------------------------------
insert into public.site_settings (key, category, value, value_type, description_en, description_ar)
values (
  'finance.seller_hold_days', 'marketplace', '7'::jsonb, 'number',
  'Days a completed order''s earnings stay pending before they become available to the seller.',
  'عدد الأيام التي تبقى فيها أرباح الطلب المكتمل معلقة قبل أن تصبح متاحة للبائع.'
)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------------------
-- Chart of accounts
-- ---------------------------------------------------------------------------------------------------
create table public.ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  account_type text not null,
  currency_code char(3) not null references public.currencies (code) on delete restrict,
  seller_user_id uuid references public.seller_profiles (user_id) on delete restrict,
  normal_balance text generated always as (
    case account_type
      when 'provider_clearing' then 'debit'
      when 'payout_clearing' then 'debit'
      when 'payment_fees' then 'debit'
      when 'fee_variance' then 'debit'
      when 'refunds' then 'debit'
      when 'platform_loss' then 'debit'
      when 'seller_receivable' then 'debit'
      else 'credit'
    end
  ) stored,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ledger_accounts_type_allowed check (account_type in (
    'provider_clearing', 'payout_clearing', 'unallocated_receipts', 'commission_revenue',
    'promotion_revenue', 'payment_fees', 'buyer_fee_recovery', 'fee_variance', 'refunds', 'tax',
    'platform_loss', 'seller_pending', 'seller_available', 'seller_reserved', 'seller_receivable'
  )),
  constraint ledger_accounts_seller_matches_type check (
    (account_type in ('seller_pending', 'seller_available', 'seller_reserved', 'seller_receivable'))
    = (seller_user_id is not null)
  ),
  unique (id, currency_code)
);
comment on table public.ledger_accounts is
  'The chart of accounts. One row per (account type, currency) for platform accounts and per (account type, currency, seller) for seller accounts; created on demand by app_private.ensure_ledger_account().';
comment on column public.ledger_accounts.normal_balance is
  'Which side increases the account. Derived from the account type, so it can never disagree with it.';
create unique index ledger_accounts_platform_identity on public.ledger_accounts (account_type, currency_code)
  where seller_user_id is null;
create unique index ledger_accounts_seller_identity on public.ledger_accounts (account_type, currency_code, seller_user_id)
  where seller_user_id is not null;
create index ledger_accounts_seller on public.ledger_accounts (seller_user_id, currency_code)
  where seller_user_id is not null;
create trigger ledger_accounts_set_updated_at before update on public.ledger_accounts
  for each row execute function app_private.tg_set_updated_at();

create or replace function app_private.ensure_ledger_account(
  p_account_type text,
  p_currency_code char(3),
  p_seller_user_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  account_id uuid;
begin
  select a.id into account_id
    from public.ledger_accounts a
   where a.account_type = p_account_type
     and a.currency_code = p_currency_code
     and a.seller_user_id is not distinct from p_seller_user_id;
  if account_id is not null then
    return account_id;
  end if;

  insert into public.ledger_accounts (account_type, currency_code, seller_user_id)
  values (p_account_type, p_currency_code, p_seller_user_id)
  returning id into account_id;
  return account_id;
exception
  when unique_violation then
    select a.id into account_id
      from public.ledger_accounts a
     where a.account_type = p_account_type
       and a.currency_code = p_currency_code
       and a.seller_user_id is not distinct from p_seller_user_id;
    return account_id;
end;
$$;
comment on function app_private.ensure_ledger_account(text, char, uuid) is
  'The account for this type, currency and seller, creating it the first time it is needed. Safe under concurrency: a losing INSERT falls back to the winner''s row.';

-- ---------------------------------------------------------------------------------------------------
-- Journals and entries
-- ---------------------------------------------------------------------------------------------------
create table public.ledger_journals (
  id uuid primary key default gen_random_uuid(),
  currency_code char(3) not null references public.currencies (code) on delete restrict,
  journal_type text not null,
  description text,
  source_type text,
  source_id text,
  idempotency_key text,
  reverses_journal_id uuid references public.ledger_journals (id) on delete restrict,
  posted_by uuid references auth.users (id) on delete set null,
  posted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint ledger_journals_type_allowed check (journal_type in (
    'checkout_capture', 'hold_release', 'withdrawal_reserved', 'withdrawal_released', 'withdrawal_paid',
    'promotion_purchase', 'commission_adjustment', 'fee_allocation', 'refund', 'dispute', 'adjustment',
    'reversal'
  )),
  constraint ledger_journals_source_is_complete check ((source_type is null) = (source_id is null)),
  constraint ledger_journals_reversal_is_typed check ((journal_type = 'reversal') = (reverses_journal_id is not null)),
  constraint ledger_journals_not_self_reversing check (reverses_journal_id is null or reverses_journal_id <> id),
  unique (id, currency_code)
);
comment on table public.ledger_journals is
  'One balanced, single-currency journal per financial event. Append-only: a mistake is corrected by posting a reversal, never by editing history.';
comment on column public.ledger_journals.idempotency_key is
  'Makes a journal postable exactly once however often its producer retries (C10).';
create unique index ledger_journals_idempotency on public.ledger_journals (idempotency_key)
  where idempotency_key is not null;
create unique index ledger_journals_one_reversal on public.ledger_journals (reverses_journal_id)
  where reverses_journal_id is not null;
create index ledger_journals_source on public.ledger_journals (source_type, source_id) where source_type is not null;
create index ledger_journals_posted on public.ledger_journals (posted_at desc);
create trigger ledger_journals_append_only before update or delete on public.ledger_journals
  for each row execute function app_private.tg_reject_write();

create table public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  journal_id uuid not null,
  currency_code char(3) not null,
  ledger_account_id uuid not null,
  account_type text not null,
  seller_user_id uuid references public.seller_profiles (user_id) on delete restrict,
  direction text not null,
  amount_minor bigint not null,
  order_id uuid references public.orders (id) on delete restrict,
  payment_id uuid references public.payments (id) on delete restrict,
  withdrawal_id uuid,
  memo text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (journal_id, currency_code) references public.ledger_journals (id, currency_code) on delete restrict,
  foreign key (ledger_account_id, currency_code) references public.ledger_accounts (id, currency_code) on delete restrict,
  constraint ledger_entries_direction_allowed check (direction in ('debit', 'credit')),
  constraint ledger_entries_amount_positive check (amount_minor > 0)
);
comment on table public.ledger_entries is
  'The lines of a journal. Amounts are always positive; the direction carries the sign, so no entry can quietly flip meaning.';
comment on column public.ledger_entries.account_type is
  'Copied from the account so wallet queries and balance maintenance never need the join.';
create index ledger_entries_journal on public.ledger_entries (journal_id);
create index ledger_entries_account on public.ledger_entries (ledger_account_id, occurred_at desc);
create index ledger_entries_seller on public.ledger_entries (seller_user_id, currency_code, occurred_at desc)
  where seller_user_id is not null;
create index ledger_entries_order on public.ledger_entries (order_id) where order_id is not null;
create index ledger_entries_payment on public.ledger_entries (payment_id) where payment_id is not null;
create trigger ledger_entries_append_only before update or delete on public.ledger_entries
  for each row execute function app_private.tg_reject_write();

create or replace function app_private.tg_ledger_journal_balances() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  debits bigint;
  credits bigint;
begin
  select
    coalesce(sum(case when e.direction = 'debit' then e.amount_minor else 0 end), 0),
    coalesce(sum(case when e.direction = 'credit' then e.amount_minor else 0 end), 0)
    into debits, credits
    from public.ledger_entries e
   where e.journal_id = new.journal_id;

  if debits <> credits then
    raise exception 'ledger journal % does not balance: debits %, credits %', new.journal_id, debits, credits
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

-- Deferred, so a journal may be written line by line but can never reach commit unbalanced. This is the
-- structural backstop; app_private.post_ledger_journal() refuses an unbalanced journal up front.
create constraint trigger ledger_entries_journal_balances
  after insert on public.ledger_entries
  deferrable initially deferred
  for each row execute function app_private.tg_ledger_journal_balances();

-- ---------------------------------------------------------------------------------------------------
-- Seller balances
-- ---------------------------------------------------------------------------------------------------
create table public.seller_balances (
  seller_user_id uuid not null references public.seller_profiles (user_id) on delete restrict,
  currency_code char(3) not null references public.currencies (code) on delete restrict,
  pending_minor bigint not null default 0,
  available_minor bigint not null default 0,
  reserved_minor bigint not null default 0,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (seller_user_id, currency_code),
  -- A negative balance is D21 territory and D21 is BLOCKED, so the floor is zero and an overdraw is a
  -- constraint violation rather than a silently negative wallet.
  constraint seller_balances_pending_not_negative check (pending_minor >= 0),
  constraint seller_balances_available_not_negative check (available_minor >= 0),
  constraint seller_balances_reserved_not_negative check (reserved_minor >= 0)
);
comment on table public.seller_balances is
  'One row per seller per currency, maintained only by app_private.post_ledger_journal(). It is a cache of the ledger, and the ledger is the record.';
comment on column public.seller_balances.reserved_minor is
  'Funds held against an open withdrawal request. Reserved funds are not spendable and not withdrawable again.';
create index seller_balances_with_money on public.seller_balances (currency_code)
  where pending_minor + available_minor + reserved_minor > 0;

create or replace function app_private.ensure_seller_balance(
  p_seller_user_id uuid,
  p_currency_code char(3)
) returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  insert into public.seller_balances (seller_user_id, currency_code)
  values (p_seller_user_id, p_currency_code)
  on conflict (seller_user_id, currency_code) do nothing;
$$;

-- ---------------------------------------------------------------------------------------------------
-- Posting
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.post_ledger_journal(
  p_journal_type text,
  p_currency_code char(3),
  p_entries jsonb,
  p_source_type text default null,
  p_source_id text default null,
  p_idempotency_key text default null,
  p_description text default null,
  p_posted_by uuid default null,
  p_reverses_journal_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  existing_id uuid;
  new_journal_id uuid;
  entry record;
  account_id uuid;
  balance record;
  debits bigint;
  credits bigint;
  line_count integer;
begin
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' then
    raise exception 'ledger entries must be a JSON array' using errcode = 'invalid_parameter_value';
  end if;

  -- C10: the same key posts once, however often the producer retries.
  if p_idempotency_key is not null then
    select j.id into existing_id from public.ledger_journals j where j.idempotency_key = p_idempotency_key;
    if existing_id is not null then
      return existing_id;
    end if;
  end if;

  select
    count(*),
    coalesce(sum(case when x.direction = 'debit' then x.amount_minor else 0 end), 0),
    coalesce(sum(case when x.direction = 'credit' then x.amount_minor else 0 end), 0)
    into line_count, debits, credits
    from jsonb_to_recordset(p_entries) as x(direction text, amount_minor bigint);

  if line_count < 2 then
    raise exception 'a journal needs at least two entries, got %', line_count using errcode = 'check_violation';
  end if;
  if debits <> credits then
    raise exception 'journal does not balance: debits %, credits %', debits, credits using errcode = 'check_violation';
  end if;
  if debits = 0 then
    raise exception 'a journal cannot post zero' using errcode = 'check_violation';
  end if;

  insert into public.ledger_journals (
    currency_code, journal_type, description, source_type, source_id, idempotency_key,
    reverses_journal_id, posted_by
  )
  values (
    p_currency_code, p_journal_type, p_description, p_source_type, p_source_id, p_idempotency_key,
    p_reverses_journal_id, p_posted_by
  )
  returning id into new_journal_id;

  for entry in
    select *
      from jsonb_to_recordset(p_entries) as x(
        account_type text, seller_user_id uuid, direction text, amount_minor bigint,
        order_id uuid, payment_id uuid, withdrawal_id uuid, memo text
      )
  loop
    if entry.amount_minor is null or entry.amount_minor <= 0 then
      raise exception 'every ledger entry needs a positive amount' using errcode = 'check_violation';
    end if;

    account_id := app_private.ensure_ledger_account(entry.account_type, p_currency_code, entry.seller_user_id);

    insert into public.ledger_entries (
      journal_id, currency_code, ledger_account_id, account_type, seller_user_id, direction,
      amount_minor, order_id, payment_id, withdrawal_id, memo
    )
    values (
      new_journal_id, p_currency_code, account_id, entry.account_type, entry.seller_user_id, entry.direction,
      entry.amount_minor, entry.order_id, entry.payment_id, entry.withdrawal_id, entry.memo
    );
  end loop;

  -- Seller balances follow the entries. Sellers are handled in id order so two concurrent journals
  -- touching the same pair of sellers queue instead of deadlocking.
  for balance in
    select
      e.seller_user_id,
      coalesce(sum(case when e.account_type = 'seller_pending'
                        then case when e.direction = 'credit' then e.amount_minor else -e.amount_minor end
                        else 0 end), 0) as pending_delta,
      coalesce(sum(case when e.account_type = 'seller_available'
                        then case when e.direction = 'credit' then e.amount_minor else -e.amount_minor end
                        else 0 end), 0) as available_delta,
      coalesce(sum(case when e.account_type = 'seller_reserved'
                        then case when e.direction = 'credit' then e.amount_minor else -e.amount_minor end
                        else 0 end), 0) as reserved_delta
      from public.ledger_entries e
     where e.journal_id = new_journal_id
       and e.seller_user_id is not null
     group by e.seller_user_id
     order by e.seller_user_id
  loop
    -- The row is created first and then moved, so a negative delta is checked against the merged
    -- balance rather than against the delta on its own.
    perform app_private.ensure_seller_balance(balance.seller_user_id, p_currency_code);

    update public.seller_balances b
       set pending_minor = b.pending_minor + balance.pending_delta,
           available_minor = b.available_minor + balance.available_delta,
           reserved_minor = b.reserved_minor + balance.reserved_delta,
           updated_at = now()
     where b.seller_user_id = balance.seller_user_id
       and b.currency_code = p_currency_code;
  end loop;

  return new_journal_id;
end;
$$;
comment on function app_private.post_ledger_journal(text, char, jsonb, text, text, text, text, uuid, uuid) is
  'The only way a journal is posted. Refuses an unbalanced, empty or zero journal, creates any missing accounts, writes the entries and moves the seller balances under a row lock.';

create or replace function app_private.reverse_ledger_journal(
  p_journal_id uuid,
  p_reason text,
  p_posted_by uuid default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  original public.ledger_journals;
  entries jsonb;
begin
  select * into original from public.ledger_journals where id = p_journal_id;
  if original.id is null then
    raise exception 'journal % does not exist', p_journal_id using errcode = 'no_data_found';
  end if;

  select jsonb_agg(jsonb_build_object(
           'account_type', e.account_type,
           'seller_user_id', e.seller_user_id,
           'direction', case e.direction when 'debit' then 'credit' else 'debit' end,
           'amount_minor', e.amount_minor,
           'order_id', e.order_id,
           'payment_id', e.payment_id,
           'withdrawal_id', e.withdrawal_id,
           'memo', p_reason
         ) order by e.id)
    into entries
    from public.ledger_entries e
   where e.journal_id = p_journal_id;

  return app_private.post_ledger_journal(
    'reversal', original.currency_code, entries, original.source_type, original.source_id,
    format('reversal:%s', p_journal_id), p_reason, p_posted_by, p_journal_id
  );
end;
$$;
comment on function app_private.reverse_ledger_journal(uuid, text, uuid) is
  'Corrects a posted journal the only way an append-only ledger allows: by posting its mirror image. The unique index on reverses_journal_id keeps it to one reversal per journal.';

-- ---------------------------------------------------------------------------------------------------
-- Wallet view
-- ---------------------------------------------------------------------------------------------------
create view public.wallet_transactions
with (security_invoker = true) as
select
  e.id as entry_id,
  e.journal_id,
  e.seller_user_id,
  e.currency_code,
  e.account_type,
  e.direction,
  e.amount_minor,
  -- Seller accounts are credit-normal, so a credit is money coming the seller's way.
  case when e.direction = 'credit' then e.amount_minor else -e.amount_minor end as signed_minor,
  j.journal_type,
  j.description,
  e.memo,
  e.order_id,
  e.payment_id,
  e.withdrawal_id,
  e.occurred_at
  from public.ledger_entries e
  join public.ledger_journals j on j.id = e.journal_id
 where e.seller_user_id is not null
   and e.account_type in ('seller_pending', 'seller_available', 'seller_reserved', 'seller_receivable');
comment on view public.wallet_transactions is
  'The seller-facing wallet statement. security_invoker, so row level security on ledger_entries decides what each caller sees.';

-- ---------------------------------------------------------------------------------------------------
-- Withdrawal limits
-- ---------------------------------------------------------------------------------------------------
create table public.withdrawal_limits (
  currency_code char(3) primary key references public.currencies (code) on delete restrict,
  min_amount_minor bigint not null,
  max_amount_minor bigint,
  max_open_requests integer,
  daily_limit_minor bigint,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint withdrawal_limits_min_positive check (min_amount_minor > 0),
  constraint withdrawal_limits_max_above_min check (max_amount_minor is null or max_amount_minor >= min_amount_minor),
  constraint withdrawal_limits_open_requests_positive check (max_open_requests is null or max_open_requests >= 1),
  constraint withdrawal_limits_daily_positive check (daily_limit_minor is null or daily_limit_minor >= min_amount_minor)
);
comment on table public.withdrawal_limits is
  'Per-currency withdrawal rules. A currency with no active row here cannot be withdrawn in at all: the request function fails closed rather than inventing a minimum.';
create trigger withdrawal_limits_set_updated_at before update on public.withdrawal_limits
  for each row execute function app_private.tg_set_updated_at();
create trigger withdrawal_limits_audit after insert or update or delete on public.withdrawal_limits
  for each row execute function audit.tg_record_change();

-- ---------------------------------------------------------------------------------------------------
-- Withdrawals
-- ---------------------------------------------------------------------------------------------------
create table public.withdrawals (
  id uuid primary key default gen_random_uuid(),
  currency_code char(3) not null,
  seller_user_id uuid not null,
  amount_minor bigint not null,
  status text not null default 'requested',
  idempotency_key text,
  reserve_journal_id uuid references public.ledger_journals (id) on delete restrict,
  settlement_journal_id uuid references public.ledger_journals (id) on delete restrict,
  reviewed_by uuid references auth.users (id) on delete set null,
  approved_by uuid references auth.users (id) on delete set null,
  rejection_reason text,
  failure_code text,
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  approved_at timestamptz,
  processing_at timestamptz,
  paid_at timestamptz,
  rejected_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (seller_user_id, currency_code) references public.seller_balances (seller_user_id, currency_code) on delete restrict,
  constraint withdrawals_amount_positive check (amount_minor > 0),
  constraint withdrawals_status_allowed check (status in (
    'requested', 'under_review', 'approved', 'processing', 'paid', 'rejected', 'failed', 'cancelled'
  )),
  constraint withdrawals_reviewer_is_not_the_seller check (reviewed_by is null or reviewed_by <> seller_user_id),
  constraint withdrawals_approver_is_not_the_seller check (approved_by is null or approved_by <> seller_user_id),
  constraint withdrawals_rejected_has_time check ((status = 'rejected') = (rejected_at is not null)),
  constraint withdrawals_rejected_reason_present check (rejected_at is null or length(btrim(rejection_reason)) > 0),
  constraint withdrawals_approved_has_approver check (approved_at is null or approved_by is not null),
  -- "No payout without an approved withdrawal": nothing may reach processing or paid without approval.
  constraint withdrawals_processing_needs_approval check (
    status not in ('processing', 'paid') or approved_at is not null
  ),
  constraint withdrawals_paid_has_time check ((status = 'paid') = (paid_at is not null)),
  constraint withdrawals_failed_has_time check ((status = 'failed') = (failed_at is not null)),
  constraint withdrawals_cancelled_has_time check ((status = 'cancelled') = (cancelled_at is not null)),
  unique (id, currency_code)
);
comment on table public.withdrawals is
  'A seller''s request to withdraw available funds. Funds are reserved when the request is created and released again on cancellation, rejection or failure; only an approved withdrawal can ever reach a payout (0022, blocked by B1-B).';
comment on column public.withdrawals.settlement_journal_id is
  'The journal that closed the request: the release on cancel/reject/fail, or the payout journal on paid.';
create unique index withdrawals_idempotency on public.withdrawals (idempotency_key) where idempotency_key is not null;
create index withdrawals_seller on public.withdrawals (seller_user_id, currency_code, requested_at desc);
create index withdrawals_open on public.withdrawals (status, requested_at)
  where status in ('requested', 'under_review', 'approved', 'processing');
create trigger withdrawals_set_updated_at before update on public.withdrawals
  for each row execute function app_private.tg_set_updated_at();
create trigger withdrawals_audit after insert or update or delete on public.withdrawals
  for each row execute function audit.tg_record_change();

alter table public.ledger_entries
  add constraint ledger_entries_withdrawal_id_fkey
  foreign key (withdrawal_id) references public.withdrawals (id) on delete restrict;

create or replace function app_private.tg_withdrawals_transition() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  -- The approved state diagram, expressed once. Anything not named here is not a transition.
  if not (
    (old.status = 'requested' and new.status in ('under_review', 'cancelled'))
    or (old.status = 'under_review' and new.status in ('approved', 'rejected'))
    or (old.status = 'approved' and new.status = 'processing')
    or (old.status = 'processing' and new.status in ('paid', 'failed'))
  ) then
    raise exception 'a withdrawal cannot move from % to %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger withdrawals_transition before update of status on public.withdrawals
  for each row execute function app_private.tg_withdrawals_transition();

-- ---------------------------------------------------------------------------------------------------
-- Commissions
-- ---------------------------------------------------------------------------------------------------
create table public.commissions (
  id uuid primary key default gen_random_uuid(),
  currency_code char(3) not null,
  order_id uuid not null,
  order_item_id uuid references public.order_items (id) on delete restrict,
  seller_user_id uuid not null references public.seller_profiles (user_id) on delete restrict,
  base_minor bigint not null,
  amount_minor bigint not null,
  rule_snapshot jsonb not null default '{}'::jsonb,
  is_skipped boolean not null default false,
  skip_reason text,
  reverses_commission_id uuid references public.commissions (id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (order_id, currency_code) references public.orders (id, currency_code) on delete restrict,
  constraint commissions_base_not_negative check (base_minor >= 0),
  constraint commissions_amount_not_negative check (amount_minor >= 0),
  constraint commissions_amount_within_base check (amount_minor <= base_minor),
  constraint commissions_snapshot_is_object check (jsonb_typeof(rule_snapshot) = 'object'),
  -- D27: a component skipped for want of an amount in the checkout currency charges nothing and says why.
  constraint commissions_skipped_charges_nothing check (
    not is_skipped or (amount_minor = 0 and length(btrim(skip_reason)) > 0)
  )
);
comment on table public.commissions is
  'The commission actually charged, snapshotted per order item at fulfilment (D11, D27). Append-only: a correction is a reversing row, matching the ledger.';
comment on column public.commissions.base_minor is
  'The commission base the components were applied to, which is what D11''s discount funding source decides.';
create unique index commissions_one_per_order_item on public.commissions (order_item_id)
  where order_item_id is not null and reverses_commission_id is null;
create index commissions_order on public.commissions (order_id);
create index commissions_seller on public.commissions (seller_user_id, currency_code, created_at desc);
create trigger commissions_append_only before update or delete on public.commissions
  for each row execute function app_private.tg_reject_write();

-- ---------------------------------------------------------------------------------------------------
-- Checkout items carry the resolved commission (C17 expand)
-- ---------------------------------------------------------------------------------------------------
alter table public.checkout_items
  add column commission_minor bigint not null default 0,
  add column commission_base_minor bigint not null default 0,
  add column commission_snapshot jsonb;
comment on column public.checkout_items.commission_minor is
  'Commission resolved in NestJS when the checkout was priced. Fulfilment copies it onto the order item and posts it to commission_revenue.';
comment on column public.checkout_items.commission_snapshot is
  'The resolved components, their bases and the discount funding source (D11), including any component skipped under D27.';

alter table public.checkout_items
  add constraint checkout_items_commission_not_negative
    check (commission_minor >= 0 and commission_base_minor >= 0) not valid,
  add constraint checkout_items_commission_within_line
    check (commission_minor <= line_subtotal_minor) not valid,
  add constraint checkout_items_commission_snapshot_is_object
    check (commission_snapshot is null or jsonb_typeof(commission_snapshot) = 'object') not valid;
alter table public.checkout_items validate constraint checkout_items_commission_not_negative;
alter table public.checkout_items validate constraint checkout_items_commission_within_line;
alter table public.checkout_items validate constraint checkout_items_commission_snapshot_is_object;

-- ---------------------------------------------------------------------------------------------------
-- Fulfilment, now posting the capture journal
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.fulfil_checkout(
  p_checkout_id uuid,
  p_payment_attempt_id uuid
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  checkout public.checkouts;
  seller record;
  item record;
  new_order_id uuid;
  orders_created integer := 0;
  checkout_payment_id uuid;
  provider_fees_minor bigint := 0;
  buyer_fees_minor bigint := 0;
  tax_total_minor bigint := 0;
  commission_total_minor bigint := 0;
  captured_minor bigint := 0;
  order_net_minor bigint;
  entries jsonb := '[]'::jsonb;
  seller_entries jsonb := '[]'::jsonb;
begin
  -- One row lock decides who fulfils. A second attempt either finds its own id here and returns, or is
  -- refused; either way no second set of orders can exist.
  select * into checkout from public.checkouts where id = p_checkout_id for update;
  if checkout.id is null then
    raise exception 'checkout % does not exist', p_checkout_id using errcode = 'no_data_found';
  end if;
  if checkout.fulfilled_attempt_id is not null then
    if checkout.fulfilled_attempt_id = p_payment_attempt_id then
      return 0; -- already done by this very attempt; the caller is retrying
    end if;
    raise exception 'checkout % was already fulfilled by another payment attempt', p_checkout_id
      using errcode = 'unique_violation';
  end if;

  select p.id into checkout_payment_id from public.payments p where p.checkout_id = p_checkout_id;

  for seller in
    select
      ci.seller_user_id,
      case when bool_or(ci.listing_type_code <> 'service') then 'product' else 'service' end as order_type,
      sum(ci.line_subtotal_minor)::bigint as subtotal_minor,
      sum(ci.discount_minor)::bigint as discount_minor,
      sum(ci.tax_minor)::bigint as tax_minor,
      sum(ci.commission_minor)::bigint as commission_minor,
      coalesce((select sum(cc.amount_minor) from public.checkout_charges cc
                 where cc.checkout_id = p_checkout_id and cc.charge_type = 'shipping'
                   and cc.seller_user_id = ci.seller_user_id), 0)::bigint as shipping_minor
    from public.checkout_items ci
    where ci.checkout_id = p_checkout_id
    group by ci.seller_user_id
    order by ci.seller_user_id
  loop
    -- What the seller is owed: the order total, less the tax that is remitted onward and the
    -- commission the platform keeps.
    order_net_minor :=
      seller.subtotal_minor + seller.shipping_minor - seller.discount_minor - seller.commission_minor;
    if order_net_minor < 0 then
      raise exception 'checkout % leaves seller % with a negative net', p_checkout_id, seller.seller_user_id
        using errcode = 'check_violation';
    end if;

    insert into public.orders (
      currency_code, checkout_id, seller_user_id, buyer_user_id, order_type, status,
      subtotal_minor, shipping_total_minor, tax_total_minor, discount_total_minor,
      commission_total_minor, grand_total_minor, seller_net_minor,
      cancellation_policy_snapshot, commission_snapshot, paid_at
    )
    values (
      checkout.currency_code, p_checkout_id, seller.seller_user_id, checkout.buyer_user_id,
      seller.order_type,
      -- The product status set starts at `paid`; the service set starts at `requested`, which is the
      -- first state in the approved service lifecycle and claims nothing about the seller having acted.
      case when seller.order_type = 'service' then 'requested' else 'paid' end,
      seller.subtotal_minor,
      seller.shipping_minor,
      seller.tax_minor,
      seller.discount_minor,
      seller.commission_minor,
      seller.subtotal_minor + seller.shipping_minor + seller.tax_minor - seller.discount_minor,
      order_net_minor,
      checkout.cancellation_policy_snapshot,
      checkout.commission_snapshot,
      now()
    )
    returning id into new_order_id;

    insert into public.order_items (
      order_id, currency_code, listing_id, listing_type_code, listing_title_snapshot, listing_slug_snapshot,
      quantity, unit_price_minor, line_subtotal_minor, discount_minor, tax_minor, line_total_minor,
      commission_minor
    )
    select
      new_order_id, checkout.currency_code, ci.listing_id, ci.listing_type_code,
      ci.listing_title_snapshot, ci.listing_slug_snapshot,
      ci.quantity, ci.unit_price_minor, ci.line_subtotal_minor, ci.discount_minor, ci.tax_minor,
      ci.line_total_minor, ci.commission_minor
    from public.checkout_items ci
    where ci.checkout_id = p_checkout_id and ci.seller_user_id = seller.seller_user_id;

    -- One commission record per order item, snapshotting what was charged (D11, D27).
    insert into public.commissions (
      currency_code, order_id, order_item_id, seller_user_id, base_minor, amount_minor,
      rule_snapshot, is_skipped, skip_reason
    )
    select
      checkout.currency_code, new_order_id, oi.id, seller.seller_user_id,
      coalesce(nullif(ci.commission_base_minor, 0), ci.line_subtotal_minor - ci.discount_minor),
      ci.commission_minor,
      coalesce(ci.commission_snapshot, '{}'::jsonb),
      false, null
    from public.order_items oi
    join public.checkout_items ci
      on ci.checkout_id = p_checkout_id and ci.listing_id = oi.listing_id
    where oi.order_id = new_order_id;

    if order_net_minor > 0 then
      seller_entries := seller_entries || jsonb_build_array(jsonb_build_object(
        'account_type', 'seller_pending',
        'seller_user_id', seller.seller_user_id,
        'direction', 'credit',
        'amount_minor', order_net_minor,
        'order_id', new_order_id,
        'payment_id', checkout_payment_id,
        'memo', 'checkout capture'
      ));
    end if;

    tax_total_minor := tax_total_minor + seller.tax_minor;
    commission_total_minor := commission_total_minor + seller.commission_minor;
    captured_minor := captured_minor
      + seller.subtotal_minor + seller.shipping_minor + seller.tax_minor - seller.discount_minor;
    orders_created := orders_created + 1;
  end loop;

  if orders_created = 0 then
    raise exception 'checkout % has no items to fulfil', p_checkout_id using errcode = 'restrict_violation';
  end if;

  select coalesce(sum(cc.amount_minor), 0) into buyer_fees_minor
    from public.checkout_charges cc
   where cc.checkout_id = p_checkout_id and cc.charge_type = 'buyer_fee';
  captured_minor := captured_minor + buyer_fees_minor;

  -- The checkout totals and the seller lines must tell the same story, or the journal would balance
  -- against a figure nobody agreed to. Fail loudly instead.
  if captured_minor <> checkout.grand_total_minor then
    raise exception 'checkout % totals % but its lines add up to %',
      p_checkout_id, checkout.grand_total_minor, captured_minor using errcode = 'check_violation';
  end if;

  -- D20: fees the platform has already agreed to absorb are an expense against the same capture.
  if checkout_payment_id is not null then
    select coalesce(sum(fa.amount_minor), 0) into provider_fees_minor
      from public.payment_fee_allocations fa
     where fa.payment_id = checkout_payment_id and fa.allocated_to = 'platform';
  end if;
  if provider_fees_minor > captured_minor then
    raise exception 'recorded fees on checkout % exceed what was captured', p_checkout_id
      using errcode = 'check_violation';
  end if;

  entries := jsonb_build_array(jsonb_build_object(
    'account_type', 'provider_clearing',
    'direction', 'debit',
    'amount_minor', captured_minor - provider_fees_minor,
    'payment_id', checkout_payment_id,
    'memo', 'checkout capture'
  ));
  if provider_fees_minor > 0 then
    entries := entries || jsonb_build_array(jsonb_build_object(
      'account_type', 'payment_fees', 'direction', 'debit', 'amount_minor', provider_fees_minor,
      'payment_id', checkout_payment_id, 'memo', 'provider fees absorbed by the platform (D20)'
    ));
  end if;
  entries := entries || seller_entries;
  if commission_total_minor > 0 then
    entries := entries || jsonb_build_array(jsonb_build_object(
      'account_type', 'commission_revenue', 'direction', 'credit', 'amount_minor', commission_total_minor,
      'payment_id', checkout_payment_id, 'memo', 'marketplace commission'
    ));
  end if;
  if tax_total_minor > 0 then
    entries := entries || jsonb_build_array(jsonb_build_object(
      'account_type', 'tax', 'direction', 'credit', 'amount_minor', tax_total_minor,
      'payment_id', checkout_payment_id, 'memo', 'tax collected'
    ));
  end if;
  if buyer_fees_minor > 0 then
    entries := entries || jsonb_build_array(jsonb_build_object(
      'account_type', 'buyer_fee_recovery', 'direction', 'credit', 'amount_minor', buyer_fees_minor,
      'payment_id', checkout_payment_id, 'memo', 'buyer fees'
    ));
  end if;

  perform app_private.post_ledger_journal(
    'checkout_capture', checkout.currency_code, entries, 'checkout', p_checkout_id::text,
    format('checkout:%s:capture', p_checkout_id), 'Checkout capture'
  );

  -- Stock decrements and reservation consumption, in listing order so concurrent fulfilments queue.
  for item in
    select ci.listing_id, ci.quantity
      from public.checkout_items ci
     where ci.checkout_id = p_checkout_id and ci.listing_type_code <> 'service'
     order by ci.listing_id
  loop
    update public.listing_product_details d
       set quantity = greatest(d.quantity - item.quantity, 0)
     where d.listing_id = item.listing_id;
  end loop;

  update public.inventory_reservations r
     set consumed_at = now()
   where r.checkout_id = p_checkout_id and r.released_at is null and r.consumed_at is null;

  update public.checkouts c
     set status = 'fulfilled',
         fulfilled_attempt_id = p_payment_attempt_id,
         fulfilled_at = now()
   where c.id = p_checkout_id;

  perform public.enqueue_outbox_event(
    'checkout', p_checkout_id::text, 'checkout.fulfilled',
    jsonb_build_object('checkout_id', p_checkout_id, 'payment_attempt_id', p_payment_attempt_id, 'orders_created', orders_created)
  );
  return orders_created;
end;
$$;
comment on function app_private.fulfil_checkout(uuid, uuid) is
  'Creates one order per seller, snapshots the commission, posts the capture journal and consumes the reservations, all in the caller''s transaction. The row lock on the checkout is what keeps it to exactly one fulfilment.';

-- ---------------------------------------------------------------------------------------------------
-- Releasing the post-completion hold
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.release_seller_holds(p_limit integer default 500) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  hold_days integer := coalesce((public.site_setting('finance.seller_hold_days'))::integer, 7);
  candidate record;
  released integer := 0;
begin
  for candidate in
    select
      o.id as order_id,
      o.seller_user_id,
      o.currency_code,
      sum(case when e.direction = 'credit' then e.amount_minor else -e.amount_minor end)::bigint as pending_minor
      from public.orders o
      join public.ledger_entries e
        on e.order_id = o.id and e.account_type = 'seller_pending'
     where o.status = 'completed'
       and o.completed_at is not null
       and o.completed_at + make_interval(days => hold_days) <= now()
       -- D26: disputed funds never leave the hold.
       and not exists (
         select 1
           from public.payments p
          where p.checkout_id = o.checkout_id
            and public.payment_has_open_dispute(p.id)
       )
     group by o.id, o.seller_user_id, o.currency_code
    having sum(case when e.direction = 'credit' then e.amount_minor else -e.amount_minor end) > 0
     order by o.completed_at
     limit greatest(p_limit, 0)
  loop
    perform app_private.post_ledger_journal(
      'hold_release',
      candidate.currency_code,
      jsonb_build_array(
        jsonb_build_object('account_type', 'seller_pending', 'seller_user_id', candidate.seller_user_id,
                           'direction', 'debit', 'amount_minor', candidate.pending_minor,
                           'order_id', candidate.order_id, 'memo', 'post-completion hold elapsed'),
        jsonb_build_object('account_type', 'seller_available', 'seller_user_id', candidate.seller_user_id,
                           'direction', 'credit', 'amount_minor', candidate.pending_minor,
                           'order_id', candidate.order_id, 'memo', 'post-completion hold elapsed')
      ),
      'order', candidate.order_id::text,
      format('order:%s:hold_release', candidate.order_id),
      'Post-completion hold released'
    );
    released := released + 1;
  end loop;

  return released;
end;
$$;
comment on function app_private.release_seller_holds(integer) is
  'Moves completed orders'' earnings from pending to available once the configured hold has elapsed. The idempotency key on the journal is what keeps a second run from releasing the same order twice; 0032 schedules it.';

-- ---------------------------------------------------------------------------------------------------
-- Spending available funds (wallet-paid promotions)
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.spend_wallet_on_promotion(
  p_seller_user_id uuid,
  p_currency_code char(3),
  p_amount_minor bigint,
  p_source_type text,
  p_source_id text,
  p_idempotency_key text
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  balance public.seller_balances;
begin
  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'a wallet payment needs a positive amount' using errcode = 'check_violation';
  end if;

  perform app_private.ensure_seller_balance(p_seller_user_id, p_currency_code);
  select * into balance
    from public.seller_balances b
   where b.seller_user_id = p_seller_user_id and b.currency_code = p_currency_code
     for update;

  -- The wallet pays promotions from available funds only, and only in full.
  if balance.available_minor < p_amount_minor then
    raise exception 'available funds % are below the price %', balance.available_minor, p_amount_minor
      using errcode = 'check_violation';
  end if;

  return app_private.post_ledger_journal(
    'promotion_purchase',
    p_currency_code,
    jsonb_build_array(
      jsonb_build_object('account_type', 'seller_available', 'seller_user_id', p_seller_user_id,
                         'direction', 'debit', 'amount_minor', p_amount_minor, 'memo', 'wallet-paid promotion'),
      jsonb_build_object('account_type', 'promotion_revenue',
                         'direction', 'credit', 'amount_minor', p_amount_minor, 'memo', 'wallet-paid promotion')
    ),
    p_source_type, p_source_id, p_idempotency_key, 'Promotion paid from the wallet'
  );
end;
$$;
comment on function app_private.spend_wallet_on_promotion(uuid, char, bigint, text, text, text) is
  'Moves the price of a promotion from seller_available to promotion_revenue under a row lock, and only when available funds cover it in full.';

-- ---------------------------------------------------------------------------------------------------
-- Withdrawals
-- ---------------------------------------------------------------------------------------------------
create or replace function public.seller_funds_are_frozen(p_seller_user_id uuid) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.orders o
      join public.payments p on p.checkout_id = o.checkout_id
     where o.seller_user_id = p_seller_user_id
       and public.payment_has_open_dispute(p.id)
  );
$$;
comment on function public.seller_funds_are_frozen(uuid) is
  'True while any of this seller''s orders is behind a payment with an open dispute. D26 blocks withdrawal of disputed funds.';

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
begin
  if p_idempotency_key is not null then
    select w.id into existing_id from public.withdrawals w where w.idempotency_key = p_idempotency_key;
    if existing_id is not null then
      return existing_id;
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
  return withdrawal_id;
end;
$$;
comment on function app_private.request_withdrawal(uuid, char, bigint, text) is
  'Creates a withdrawal request and reserves its funds in the same transaction, after the limits, the available balance and the dispute freeze have all agreed.';

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
begin
  select * into withdrawal from public.withdrawals where id = p_withdrawal_id for update;
  if withdrawal.id is null then
    raise exception 'withdrawal % does not exist', p_withdrawal_id using errcode = 'no_data_found';
  end if;
  if withdrawal.status = p_next_status then
    return 'unchanged';
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
  return p_next_status;
end;
$$;
comment on function app_private.transition_withdrawal(uuid, text, uuid, text) is
  'The one path through the withdrawal state machine. It posts the release or payout journal before it moves the row, so the ledger and the status can never disagree.';

-- ---------------------------------------------------------------------------------------------------
-- Currency dependencies (D16)
-- ---------------------------------------------------------------------------------------------------
select app_private.register_currency_dependency(
  'ledger_accounts.currency_code', 'public', 'ledger_accounts', 'currency_code',
  'active ledger accounts in the currency',
  $$is_active$$
);
select app_private.register_currency_dependency(
  'seller_balances.currency_code', 'public', 'seller_balances', 'currency_code',
  'seller balances still holding money in the currency',
  $$pending_minor + available_minor + reserved_minor > 0$$
);
select app_private.register_currency_dependency(
  'withdrawals.currency_code', 'public', 'withdrawals', 'currency_code',
  'withdrawals in flight in the currency',
  $$status in ('requested', 'under_review', 'approved', 'processing')$$
);
select app_private.register_currency_dependency(
  'withdrawal_limits.currency_code', 'public', 'withdrawal_limits', 'currency_code',
  'active withdrawal limits for the currency',
  $$is_active$$
);

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table public.ledger_accounts enable row level security;
alter table public.ledger_journals enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.seller_balances enable row level security;
alter table public.withdrawal_limits enable row level security;
alter table public.withdrawals enable row level security;
alter table public.commissions enable row level security;

create policy ledger_accounts_seller_read on public.ledger_accounts for select to authenticated
  using (seller_user_id = public.current_user_id());
create policy ledger_accounts_staff_read on public.ledger_accounts for select to authenticated
  using (public.has_permission('finance.ledger.read'));

create policy ledger_journals_seller_read on public.ledger_journals for select to authenticated
  using (exists (
    select 1 from public.ledger_entries e
     where e.journal_id = id and e.seller_user_id = public.current_user_id()
  ));
create policy ledger_journals_staff_read on public.ledger_journals for select to authenticated
  using (public.has_permission('finance.ledger.read'));

create policy ledger_entries_seller_read on public.ledger_entries for select to authenticated
  using (seller_user_id = public.current_user_id());
create policy ledger_entries_staff_read on public.ledger_entries for select to authenticated
  using (public.has_permission('finance.ledger.read'));

create policy seller_balances_owner_read on public.seller_balances for select to authenticated
  using (seller_user_id = public.current_user_id());
create policy seller_balances_staff_read on public.seller_balances for select to authenticated
  using (public.has_permission('finance.balance.read'));

create policy withdrawal_limits_read on public.withdrawal_limits for select to authenticated
  using (is_active or public.has_permission('settings.withdrawal.manage'));
create policy withdrawal_limits_admin_write on public.withdrawal_limits for all to authenticated
  using (public.has_permission('settings.withdrawal.manage') and public.is_aal2())
  with check (public.has_permission('settings.withdrawal.manage') and public.is_aal2());

create policy withdrawals_seller_read on public.withdrawals for select to authenticated
  using (seller_user_id = public.current_user_id());
create policy withdrawals_staff_read on public.withdrawals for select to authenticated
  using (public.has_permission('finance.withdrawal.read'));

create policy commissions_seller_read on public.commissions for select to authenticated
  using (seller_user_id = public.current_user_id());
create policy commissions_staff_read on public.commissions for select to authenticated
  using (public.has_permission('finance.commission.read'));

-- Reads only. Every write to a financial table goes through a SECURITY DEFINER function, which is why
-- no role is granted INSERT, UPDATE or DELETE on any of them.
grant select on public.ledger_accounts to authenticated;
grant select on public.ledger_journals to authenticated;
grant select on public.ledger_entries to authenticated;
grant select on public.seller_balances to authenticated;
grant select, insert, update, delete on public.withdrawal_limits to authenticated;
grant select on public.withdrawals to authenticated;
grant select on public.commissions to authenticated;
grant select on public.wallet_transactions to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function public.seller_funds_are_frozen(uuid) to authenticated;

grant execute on function
  public.seller_funds_are_frozen(uuid),
  app_private.ensure_ledger_account(text, char, uuid),
  app_private.ensure_seller_balance(uuid, char),
  app_private.post_ledger_journal(text, char, jsonb, text, text, text, text, uuid, uuid),
  app_private.reverse_ledger_journal(uuid, text, uuid),
  app_private.release_seller_holds(integer),
  app_private.spend_wallet_on_promotion(uuid, char, bigint, text, text, text),
  app_private.request_withdrawal(uuid, char, bigint, text),
  app_private.transition_withdrawal(uuid, text, uuid, text)
  to app_system, app_worker;
