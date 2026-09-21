-- 0023 — Provider settlements: statements, their lines, matching against our own records, and the
-- reconciliation journal that compares the clearing accounts with what the provider says
-- (v5.2 "Ledger" — settlement reconciliation; B1-C, C10, C19, D16, UB8).
--
-- A settlement is one statement from one provider covering one period in one currency. Payment
-- providers and payout providers stay separate abstractions, so a settlement names exactly one of them
-- and its `settlement_kind` says which; the composite key `(id, settlement_kind)` then makes it
-- impossible for a payout line to appear on a payment statement, in the same way `(id, currency_code)`
-- makes a line disagree with its statement's currency impossible.
--
-- No provider is seeded, no credential lives here and no adapter exists. A statement arrives as data
-- through `app_private.open_settlement()` and `app_private.record_settlement_item()`; only a digest of
-- the source file is kept, never the file.
--
-- What the provider said is immutable. `provider_settlement_items` can never be deleted and its
-- statement-derived columns — kind, direction, amount, fee, reference, time — can never be edited; only
-- our own verdict on a line (matched, mismatched, ignored) moves, and only forwards. That is the
-- append-only rule applied where it matters: the evidence is fixed, our reading of it is what changes.
--
-- Reconciliation is two questions, asked in order:
--
--   1. Does the statement add up? `computed_net_minor` is summed from the lines; `variance_minor` is
--      what the provider's own header claims minus that. A statement that disagrees with itself is a
--      mismatch before any ledger entry is considered.
--   2. Do the lines match our records? Every line is matched by provider reference against
--      `payment_provider_transactions` or `payout_transactions`. What stays unmatched is money we
--      cannot yet attribute, which is exactly what `unallocated_receipts` is for.
--
-- The journal, when it is posted, uses only accounts from the approved chart: `payout_clearing` is
-- debited for the payouts the statement confirms have left — discharging the obligation 0021 and 0022
-- left in transit — `payment_fees` for the fees the statement reports that we had not already recorded,
-- `unallocated_receipts` for lines we cannot attribute, `fee_variance` for the statement's own
-- disagreement with itself, and `provider_clearing` takes the balancing side. No account outside those
-- fifteen is invented, and in particular nothing here posits a bank balance the platform holds (UB8).
--
-- B1-C is OPEN: "neither split payments nor platform-held balances are assumed; the settlement model
-- needs an owner decision plus legal and tax review". Posting therefore fails closed. Matching,
-- variance detection and reporting all run, but the ledger journal is only posted once the owner turns
-- on `finance.settlement_posting_enabled`, which ships as `false`. Until then a reconciled settlement
-- stops at `matched` and `reconcile_settlement()` answers `posting_blocked`, so the reconciliation
-- evidence is built up without anyone having decided the money flow.
--
-- 0021's journal-type list is extended here with `settlement`. The constraint is replaced in place,
-- which is the ordinary expand step (C17); 0021 itself is untouched.

-- ---------------------------------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------------------------------
insert into public.site_settings (key, category, value, value_type, description_en, description_ar)
values (
  'finance.settlement_posting_enabled', 'marketplace', 'false'::jsonb, 'boolean',
  'Whether reconciling a provider settlement may post its ledger journal. Stays off until the settlement model is approved (B1-C).',
  'ما إذا كان تسوية كشف المزود يسمح بترحيل قيد دفتر الأستاذ. يبقى معطلاً حتى اعتماد نموذج التسوية.'
)
on conflict (key) do nothing;

-- The ledger learns one more journal type (C17 expand; 0021 is not rewritten).
alter table public.ledger_journals drop constraint ledger_journals_type_allowed;
alter table public.ledger_journals add constraint ledger_journals_type_allowed check (journal_type in (
  'checkout_capture', 'hold_release', 'withdrawal_reserved', 'withdrawal_released', 'withdrawal_paid',
  'promotion_purchase', 'commission_adjustment', 'fee_allocation', 'refund', 'dispute', 'settlement',
  'adjustment', 'reversal'
));

-- ---------------------------------------------------------------------------------------------------
-- Reading a clearing account
-- ---------------------------------------------------------------------------------------------------
create or replace function public.clearing_account_balance(
  p_account_type text,
  p_currency_code char(3)
) returns bigint
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(sum(
    case when e.direction = 'debit' then e.amount_minor else -e.amount_minor end
  ), 0)::bigint
    from public.ledger_entries e
   where e.account_type = p_account_type
     and e.currency_code = p_currency_code
     and e.seller_user_id is null;
$$;
comment on function public.clearing_account_balance(text, char) is
  'The signed balance of a platform account, debits positive. This is the "clearing accounts" half of the comparison a settlement makes; the statement is the other half.';

-- ---------------------------------------------------------------------------------------------------
-- Settlements
-- ---------------------------------------------------------------------------------------------------
create table public.provider_settlements (
  id uuid primary key default gen_random_uuid(),
  settlement_kind text not null,
  currency_code char(3) not null references public.currencies (code) on delete restrict,
  payment_provider_id uuid references public.payment_providers (id) on delete restrict,
  payout_provider_id uuid references public.payout_providers (id) on delete restrict,
  statement_reference text not null,
  period_start date not null,
  period_end date not null,
  reported_gross_minor bigint not null default 0,
  reported_fee_minor bigint not null default 0,
  reported_net_minor bigint not null default 0,
  computed_net_minor bigint not null default 0,
  variance_minor bigint not null default 0,
  unmatched_amount_minor bigint not null default 0,
  status text not null default 'imported',
  source_digest bytea,
  ledger_journal_id uuid references public.ledger_journals (id) on delete restrict,
  posting_blocked_reason text,
  imported_at timestamptz not null default now(),
  matched_at timestamptz,
  reconciled_at timestamptz,
  reconciled_by uuid references auth.users (id) on delete set null,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint provider_settlements_kind_allowed check (settlement_kind in ('payment', 'payout')),
  -- Customer payments and seller payouts stay separate abstractions: a statement names one provider of
  -- one kind, never both and never neither.
  constraint provider_settlements_names_one_provider check (
    case settlement_kind
      when 'payment' then payment_provider_id is not null and payout_provider_id is null
      else payout_provider_id is not null and payment_provider_id is null
    end
  ),
  constraint provider_settlements_statement_reference_length check (length(btrim(statement_reference)) between 1 and 255),
  constraint provider_settlements_period_order check (period_end >= period_start),
  constraint provider_settlements_reported_amounts_positive check (
    reported_gross_minor >= 0 and reported_fee_minor >= 0 and unmatched_amount_minor >= 0
  ),
  constraint provider_settlements_status_allowed check (
    status in ('imported', 'matching', 'matched', 'reconciled', 'variance', 'closed')
  ),
  constraint provider_settlements_matched_has_time check (
    status in ('imported', 'matching') or matched_at is not null
  ),
  constraint provider_settlements_reconciled_has_time check (
    status not in ('reconciled', 'variance') or reconciled_at is not null
  ),
  -- A settlement that found a difference must say where that difference was posted.
  constraint provider_settlements_variance_has_journal check (
    status <> 'variance' or ledger_journal_id is not null
  ),
  constraint provider_settlements_closed_has_time check ((status = 'closed') = (closed_at is not null)),
  unique (id, currency_code),
  unique (id, settlement_kind)
);
comment on table public.provider_settlements is
  'One statement from one provider, for one period and one currency. Reconciling it compares the clearing accounts with what the provider says; posting the result waits for the settlement model (B1-C).';
comment on column public.provider_settlements.variance_minor is
  'What the statement header claims minus what its own lines add up to. Anything other than zero is a mismatch before the ledger is touched.';
comment on column public.provider_settlements.source_digest is
  'A digest of the statement file. The file itself is never stored here.';
comment on column public.provider_settlements.posting_blocked_reason is
  'Why a matched settlement has not been posted — normally that the settlement model is still open (B1-C).';
create unique index provider_settlements_payment_statement on public.provider_settlements (payment_provider_id, statement_reference)
  where payment_provider_id is not null;
create unique index provider_settlements_payout_statement on public.provider_settlements (payout_provider_id, statement_reference)
  where payout_provider_id is not null;
create index provider_settlements_open on public.provider_settlements (status, period_end desc)
  where status <> 'closed';
create index provider_settlements_period on public.provider_settlements (currency_code, period_start, period_end);
create trigger provider_settlements_set_updated_at before update on public.provider_settlements
  for each row execute function app_private.tg_set_updated_at();
create trigger provider_settlements_audit after insert or update or delete on public.provider_settlements
  for each row execute function audit.tg_record_change('posting_blocked_reason');

create or replace function app_private.tg_provider_settlements_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  -- What the provider sent is fixed once it is imported.
  if new.statement_reference <> old.statement_reference
     or new.settlement_kind <> old.settlement_kind
     or new.currency_code <> old.currency_code
     or new.period_start <> old.period_start
     or new.period_end <> old.period_end
     or new.reported_gross_minor <> old.reported_gross_minor
     or new.reported_fee_minor <> old.reported_fee_minor
     or new.reported_net_minor <> old.reported_net_minor then
    raise exception 'an imported statement cannot be rewritten' using errcode = 'restrict_violation';
  end if;
  if old.ledger_journal_id is not null and new.ledger_journal_id is distinct from old.ledger_journal_id then
    raise exception 'a settlement journal cannot be replaced' using errcode = 'restrict_violation';
  end if;
  if old.status = 'closed' and new.status <> 'closed' then
    raise exception 'a closed settlement is final' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger provider_settlements_guard before update on public.provider_settlements
  for each row execute function app_private.tg_provider_settlements_guard();

-- ---------------------------------------------------------------------------------------------------
-- Statement lines
-- ---------------------------------------------------------------------------------------------------
create table public.provider_settlement_items (
  id uuid primary key default gen_random_uuid(),
  provider_settlement_id uuid not null,
  settlement_kind text not null,
  currency_code char(3) not null,
  item_kind text not null,
  direction text not null,
  provider_reference text not null,
  amount_minor bigint not null,
  fee_minor bigint not null default 0,
  payment_id uuid references public.payments (id) on delete set null,
  payment_attempt_id uuid references public.payment_attempts (id) on delete set null,
  refund_id uuid references public.refunds (id) on delete set null,
  payment_dispute_id uuid references public.payment_disputes (id) on delete set null,
  payout_id uuid references public.payouts (id) on delete set null,
  payout_reversal_id uuid references public.payout_reversals (id) on delete set null,
  match_status text not null default 'unmatched',
  mismatch_reason text,
  matched_at timestamptz,
  occurred_at timestamptz not null default now(),
  recorded_at timestamptz not null default now(),
  foreign key (provider_settlement_id, currency_code)
    references public.provider_settlements (id, currency_code) on delete restrict,
  foreign key (provider_settlement_id, settlement_kind)
    references public.provider_settlements (id, settlement_kind) on delete restrict,
  constraint provider_settlement_items_kind_allowed check (
    item_kind in ('charge', 'refund', 'chargeback', 'fee', 'payout', 'payout_reversal', 'adjustment')
  ),
  -- A payout line can never appear on a payment statement, and the reverse.
  constraint provider_settlement_items_kind_matches_statement check (
    case settlement_kind
      when 'payment' then item_kind in ('charge', 'refund', 'chargeback', 'fee', 'adjustment')
      else item_kind in ('payout', 'payout_reversal', 'fee', 'adjustment')
    end
  ),
  constraint provider_settlement_items_direction_allowed check (direction in ('inbound', 'outbound')),
  constraint provider_settlement_items_amount_positive check (amount_minor > 0),
  constraint provider_settlement_items_fee_not_negative check (fee_minor >= 0),
  constraint provider_settlement_items_reference_length check (length(btrim(provider_reference)) between 1 and 255),
  constraint provider_settlement_items_match_status_allowed check (
    match_status in ('unmatched', 'matched', 'mismatched', 'ignored')
  ),
  constraint provider_settlement_items_matched_has_time check ((match_status = 'matched') = (matched_at is not null)),
  constraint provider_settlement_items_mismatched_has_reason check (
    match_status <> 'mismatched' or length(btrim(mismatch_reason)) > 0
  ),
  -- Our own records are only ever attached to a line of the kind they belong to.
  constraint provider_settlement_items_match_fits_kind check (
    (payout_id is null or item_kind in ('payout', 'payout_reversal'))
    and (payout_reversal_id is null or item_kind = 'payout_reversal')
    and (refund_id is null or item_kind = 'refund')
    and (payment_dispute_id is null or item_kind = 'chargeback')
  ),
  unique (provider_settlement_id, provider_reference, item_kind)
);
comment on table public.provider_settlement_items is
  'The lines of a statement. What the provider said is immutable; only our verdict on a line moves. The unique (statement, reference, kind) is what makes importing the same file twice a no-op (C10).';
comment on column public.provider_settlement_items.direction is
  'Which way the money went from our point of view. `computed_net_minor` is inbound less outbound.';
create index provider_settlement_items_by_settlement on public.provider_settlement_items (provider_settlement_id, match_status);
create index provider_settlement_items_reference on public.provider_settlement_items (provider_reference);
create index provider_settlement_items_payment on public.provider_settlement_items (payment_id) where payment_id is not null;
create index provider_settlement_items_payout on public.provider_settlement_items (payout_id) where payout_id is not null;

create or replace function app_private.tg_provider_settlement_items_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a statement line can never be removed' using errcode = 'restrict_violation';
  end if;

  if new.provider_settlement_id <> old.provider_settlement_id
     or new.settlement_kind <> old.settlement_kind
     or new.currency_code <> old.currency_code
     or new.item_kind <> old.item_kind
     or new.direction <> old.direction
     or new.provider_reference <> old.provider_reference
     or new.amount_minor <> old.amount_minor
     or new.fee_minor <> old.fee_minor
     or new.occurred_at <> old.occurred_at then
    raise exception 'what the provider reported on a line cannot be edited' using errcode = 'restrict_violation';
  end if;

  if old.match_status = 'matched' and new.match_status <> 'matched' then
    raise exception 'a matched line cannot be unmatched' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
comment on function app_private.tg_provider_settlement_items_guard() is
  'Keeps the evidence fixed and lets the verdict move forward only: the provider''s figures are immutable, a line can never be deleted, and a match can never be taken back.';

create trigger provider_settlement_items_guard before update or delete on public.provider_settlement_items
  for each row execute function app_private.tg_provider_settlement_items_guard();

-- ---------------------------------------------------------------------------------------------------
-- Importing a statement
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.open_settlement(
  p_settlement_kind text,
  p_currency_code char(3),
  p_provider_id uuid,
  p_statement_reference text,
  p_period_start date,
  p_period_end date,
  p_reported_gross_minor bigint default 0,
  p_reported_fee_minor bigint default 0,
  p_reported_net_minor bigint default 0,
  p_source_digest bytea default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  existing_id uuid;
  new_settlement_id uuid;
begin
  if p_settlement_kind not in ('payment', 'payout') then
    raise exception 'a settlement is of kind payment or payout, not %', p_settlement_kind
      using errcode = 'invalid_parameter_value';
  end if;

  -- C10: importing the same statement twice returns the one already there.
  select s.id into existing_id
    from public.provider_settlements s
   where s.statement_reference = p_statement_reference
     and (s.payment_provider_id = p_provider_id or s.payout_provider_id = p_provider_id);
  if existing_id is not null then
    return existing_id;
  end if;

  insert into public.provider_settlements (
    settlement_kind, currency_code, payment_provider_id, payout_provider_id, statement_reference,
    period_start, period_end, reported_gross_minor, reported_fee_minor, reported_net_minor, source_digest
  )
  values (
    p_settlement_kind, p_currency_code,
    case when p_settlement_kind = 'payment' then p_provider_id end,
    case when p_settlement_kind = 'payout' then p_provider_id end,
    p_statement_reference, p_period_start, p_period_end,
    p_reported_gross_minor, p_reported_fee_minor, p_reported_net_minor, p_source_digest
  )
  returning id into new_settlement_id;

  return new_settlement_id;
end;
$$;
comment on function app_private.open_settlement(text, char, uuid, text, date, date, bigint, bigint, bigint, bytea) is
  'Registers a provider statement. Re-importing the same reference from the same provider returns the existing settlement rather than a second one (C10).';

create or replace function app_private.record_settlement_item(
  p_settlement_id uuid,
  p_item_kind text,
  p_direction text,
  p_provider_reference text,
  p_amount_minor bigint,
  p_fee_minor bigint default 0,
  p_occurred_at timestamptz default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  settlement public.provider_settlements;
  new_item_id uuid;
begin
  select * into settlement from public.provider_settlements s where s.id = p_settlement_id;
  if settlement.id is null then
    raise exception 'settlement % does not exist', p_settlement_id using errcode = 'no_data_found';
  end if;
  if settlement.status not in ('imported', 'matching') then
    raise exception 'settlement % is % and takes no more lines', p_settlement_id, settlement.status
      using errcode = 'restrict_violation';
  end if;

  insert into public.provider_settlement_items (
    provider_settlement_id, settlement_kind, currency_code, item_kind, direction,
    provider_reference, amount_minor, fee_minor, occurred_at
  )
  values (
    p_settlement_id, settlement.settlement_kind, settlement.currency_code, p_item_kind, p_direction,
    p_provider_reference, p_amount_minor, p_fee_minor, coalesce(p_occurred_at, now())
  )
  on conflict (provider_settlement_id, provider_reference, item_kind) do nothing
  returning id into new_item_id;

  return new_item_id;
end;
$$;
comment on function app_private.record_settlement_item(uuid, text, text, text, bigint, bigint, timestamptz) is
  'Appends one statement line. A line the statement already carries is ignored, so a re-run of the import adds nothing.';

-- ---------------------------------------------------------------------------------------------------
-- Matching the statement against our own records
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.match_settlement(p_settlement_id uuid) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  settlement public.provider_settlements;
  matched_count integer := 0;
  computed_net bigint;
  unmatched_total bigint;
begin
  select * into settlement from public.provider_settlements s where s.id = p_settlement_id for update;
  if settlement.id is null then
    raise exception 'settlement % does not exist', p_settlement_id using errcode = 'no_data_found';
  end if;
  if settlement.status not in ('imported', 'matching', 'matched') then
    raise exception 'settlement % is % and is no longer being matched', p_settlement_id, settlement.status
      using errcode = 'restrict_violation';
  end if;

  update public.provider_settlements set status = 'matching' where id = p_settlement_id and status = 'imported';

  if settlement.settlement_kind = 'payment' then
    -- Payment lines are matched by the provider's own transaction reference.
    update public.provider_settlement_items i
       set payment_id = t.payment_id,
           payment_attempt_id = t.payment_attempt_id,
           match_status = 'matched',
           matched_at = now()
      from public.payment_provider_transactions t
     where i.provider_settlement_id = p_settlement_id
       and i.match_status = 'unmatched'
       and t.payment_provider_id = settlement.payment_provider_id
       and t.provider_reference = i.provider_reference
       and t.currency_code = i.currency_code
       and t.amount_minor = i.amount_minor;
  else
    update public.provider_settlement_items i
       set payout_id = t.payout_id,
           match_status = 'matched',
           matched_at = now()
      from public.payout_transactions t
     where i.provider_settlement_id = p_settlement_id
       and i.match_status = 'unmatched'
       and t.payout_provider_id = settlement.payout_provider_id
       and t.provider_reference = i.provider_reference
       and t.currency_code = i.currency_code
       and t.amount_minor = i.amount_minor;
  end if;
  get diagnostics matched_count = row_count;

  -- A fee line has nothing of ours to point at; it is evidence, not a transaction we also hold.
  update public.provider_settlement_items
     set match_status = 'ignored'
   where provider_settlement_id = p_settlement_id
     and match_status = 'unmatched'
     and item_kind = 'fee';

  select
    coalesce(sum(case when i.direction = 'inbound' then i.amount_minor else -i.amount_minor end), 0),
    coalesce(sum(case when i.match_status in ('unmatched', 'mismatched') then i.amount_minor else 0 end), 0)
    into computed_net, unmatched_total
    from public.provider_settlement_items i
   where i.provider_settlement_id = p_settlement_id;

  update public.provider_settlements
     set computed_net_minor = computed_net,
         variance_minor = reported_net_minor - computed_net,
         unmatched_amount_minor = unmatched_total,
         status = 'matched',
         matched_at = now()
   where id = p_settlement_id;

  return matched_count;
end;
$$;
comment on function app_private.match_settlement(uuid) is
  'Matches every line against our own provider transactions by reference, amount and currency, then records what the statement adds up to, what it claims, and how much is still unattributed.';

-- ---------------------------------------------------------------------------------------------------
-- Reconciling: comparing the clearing accounts with the statement
-- ---------------------------------------------------------------------------------------------------
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
    return 'posting_blocked';
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
    return 'balanced';
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

  return case when variance = 0 and unattributed = 0 then 'balanced' else 'variance' end;
end;
$$;
comment on function app_private.reconcile_settlement(uuid, uuid) is
  'Compares the clearing accounts with the statement and posts the one journal that expresses the difference. Fails closed while the settlement model is open (B1-C): the comparison is recorded, the journal is not.';

create or replace function app_private.close_settlement(p_settlement_id uuid, p_actor_user_id uuid default null)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated integer;
begin
  update public.provider_settlements
     set status = 'closed', closed_at = now(), reconciled_by = coalesce(reconciled_by, p_actor_user_id)
   where id = p_settlement_id
     and status in ('reconciled', 'variance');
  get diagnostics updated = row_count;
  if updated = 0 then
    raise exception 'only a reconciled settlement can be closed' using errcode = 'restrict_violation';
  end if;
  return true;
end;
$$;
comment on function app_private.close_settlement(uuid, uuid) is
  'Closes a reconciled settlement. A closed settlement is final: the guard trigger refuses to reopen it.';

-- ---------------------------------------------------------------------------------------------------
-- Currency dependencies (D16)
-- ---------------------------------------------------------------------------------------------------
select app_private.register_currency_dependency(
  'provider_settlements.currency_code', 'public', 'provider_settlements', 'currency_code',
  'provider settlements in the currency that are not closed',
  $$status <> 'closed'$$
);
select app_private.register_currency_dependency(
  'provider_settlement_items.currency_code', 'public', 'provider_settlement_items', 'currency_code',
  'statement lines in the currency that are still unattributed',
  $$match_status in ('unmatched', 'mismatched')$$
);

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table public.provider_settlements enable row level security;
alter table public.provider_settlement_items enable row level security;

create policy provider_settlements_staff_read on public.provider_settlements for select to authenticated
  using (public.has_permission('payments.settlement.read'));
create policy provider_settlements_staff_write on public.provider_settlements for all to authenticated
  using (public.has_permission('payments.settlement.manage') and public.is_aal2())
  with check (public.has_permission('payments.settlement.manage') and public.is_aal2());

create policy provider_settlement_items_staff_read on public.provider_settlement_items for select to authenticated
  using (public.has_permission('payments.settlement.read'));
create policy provider_settlement_items_staff_write on public.provider_settlement_items for all to authenticated
  using (public.has_permission('payments.settlement.manage') and public.is_aal2())
  with check (public.has_permission('payments.settlement.manage') and public.is_aal2());

grant select, insert, update on public.provider_settlements to authenticated;
grant select, insert, update on public.provider_settlement_items to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function public.clearing_account_balance(text, char) to authenticated;

grant execute on function
  public.clearing_account_balance(text, char),
  app_private.open_settlement(text, char, uuid, text, date, date, bigint, bigint, bigint, bytea),
  app_private.record_settlement_item(uuid, text, text, text, bigint, bigint, timestamptz),
  app_private.match_settlement(uuid),
  app_private.reconcile_settlement(uuid, uuid),
  app_private.close_settlement(uuid, uuid)
  to app_system, app_worker;
