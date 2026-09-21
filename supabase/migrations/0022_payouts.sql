-- 0022 — Payouts: providers, capabilities, destinations (Vault), payouts, transactions, events and
-- reversals (v5.2 "PayoutProvider interface", "Withdrawal and payout flow"; C10, C19, D21, D26, UB8).
--
-- Payout providers live in their own tables, separate from payment providers, even where one company
-- offers both. No provider is seeded and no adapter exists: `payout_providers` is empty until B1-B
-- closes, and every capability lookup fails closed, so nothing here assumes a particular provider or
-- that the platform holds funds (UB8).
--
-- The eligibility rule from the specification is a CHECK constraint rather than a convention: a
-- provider may only claim `supports_payout` if it also supports an idempotent payout reference or a
-- reliable status lookup by our reference. That is what makes a worker retry unable to pay twice (C10);
-- `payouts.idempotency_key` is our reference and is unique per provider.
--
-- Destination details never exist in this schema in the clear. A destination carries a `masked_value`
-- for display and exactly one of a Vault secret id or a provider token — the CHECK enforces "exactly
-- one", so there is no shape in which a bank number could be stored as an ordinary column. Changes need
-- a step-up grant and aal2 (the RLS policy is where that is enforced), are audited with the provider
-- token redacted, and emit an outbox event so the seller is told. The 72-hour hold after an account
-- recovery belongs to 0028, which is where account recovery arrives.
--
-- Payout flow, continuing the withdrawal state machine 0021 built:
--
--   approved --(create_payout)--> processing   the payout row is created; the reservation stays put
--   processing --(settle_payout 'paid')--> paid      debit seller_reserved, credit payout_clearing
--   processing --(settle_payout 'failed')--> failed  the reservation is released back to available
--
-- Both transitions go through `app_private.transition_withdrawal()`, so the ledger journal and the
-- withdrawal status can never disagree, and a payout can only ever be created for an approved
-- withdrawal — `payouts.withdrawal_id` is unique and the function refuses any other status. A payout
-- that comes back is a `payout_reversals` row whose settlement posts the mirror journal (debit
-- payout_clearing, credit seller_available); nothing is rewritten.
--
-- Not built here, on purpose: `post_payout_refund_policies` is conditional on D21, which is BLOCKED, so
-- recovering a refund from an already-paid seller has no schema yet. Settlement reconciliation against
-- provider statements is 0023 and depends on B1-C.

-- ---------------------------------------------------------------------------------------------------
-- Payout providers
-- ---------------------------------------------------------------------------------------------------
create table public.payout_providers (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  display_name text not null,
  is_enabled boolean not null default false,
  is_default boolean not null default false,
  priority integer not null default 0,
  documentation_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payout_providers_key_format check (key ~ '^[a-z][a-z0-9_]*$'),
  constraint payout_providers_display_name_length check (length(btrim(display_name)) between 1 and 80),
  constraint payout_providers_default_is_enabled check (not is_default or is_enabled),
  constraint payout_providers_documentation_url_shape check (documentation_url is null or documentation_url ~ '^https://')
);
comment on table public.payout_providers is
  'Payout mechanisms, provider-neutral and separate from payment_providers even when one company offers both. Empty until B1-B closes; a provider arrives disabled, in its own migration. Credentials never live here.';
create unique index payout_providers_key on public.payout_providers (key);
create unique index payout_providers_one_default on public.payout_providers ((is_default)) where is_default;
create trigger payout_providers_set_updated_at before update on public.payout_providers
  for each row execute function app_private.tg_set_updated_at();
create trigger payout_providers_audit after insert or update or delete on public.payout_providers
  for each row execute function audit.tg_record_change();

create table public.payout_provider_capabilities (
  payout_provider_id uuid not null references public.payout_providers (id) on delete cascade,
  currency_code char(3) not null references public.currencies (code) on delete restrict,
  supports_payout boolean not null default false,
  supports_destination_validation boolean not null default false,
  supports_destination_registration boolean not null default false,
  supports_cancel boolean not null default false,
  supports_reverse boolean not null default false,
  supports_status_lookup boolean not null default false,
  supports_provider_idempotency boolean not null default false,
  supports_webhooks boolean not null default false,
  destination_kinds text[] not null default '{}'::text[],
  amount_format text not null default 'minor',
  amount_decimal_places smallint,
  min_amount_minor bigint,
  max_amount_minor bigint,
  evidence_url text not null,
  recorded_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (payout_provider_id, currency_code),
  constraint payout_provider_capabilities_amount_format_allowed check (amount_format in ('minor', 'major_decimal')),
  constraint payout_provider_capabilities_decimal_places_range check (amount_decimal_places is null or amount_decimal_places between 0 and 4),
  constraint payout_provider_capabilities_amounts_positive check (
    (min_amount_minor is null or min_amount_minor >= 0)
    and (max_amount_minor is null or max_amount_minor >= 0)
  ),
  constraint payout_provider_capabilities_amount_order check (
    min_amount_minor is null or max_amount_minor is null or max_amount_minor >= min_amount_minor
  ),
  constraint payout_provider_capabilities_destination_kinds_allowed check (
    destination_kinds <@ array['bank_account', 'wallet', 'card', 'provider_token']::text[]
  ),
  -- The specification's eligibility rule, as a constraint: a provider that can neither be given our
  -- reference idempotently nor be asked about it afterwards can never be retried safely (C10).
  constraint payout_provider_capabilities_payout_is_retry_safe check (
    not supports_payout or supports_provider_idempotency or supports_status_lookup
  ),
  constraint payout_provider_capabilities_payout_names_a_destination check (
    not supports_payout or cardinality(destination_kinds) > 0
  ),
  constraint payout_provider_capabilities_evidence_url_shape check (evidence_url ~ '^https://')
);
comment on table public.payout_provider_capabilities is
  'What a payout provider can actually do, per currency, taken from its official documentation — `evidence_url` records where. A provider claiming payouts must also be retry-safe.';
comment on column public.payout_provider_capabilities.destination_kinds is
  'The destination kinds this provider accepts in this currency. A destination of any other kind is refused.';
create trigger payout_provider_capabilities_set_updated_at before update on public.payout_provider_capabilities
  for each row execute function app_private.tg_set_updated_at();
create trigger payout_provider_capabilities_audit after insert or update or delete on public.payout_provider_capabilities
  for each row execute function audit.tg_record_change();

create or replace function public.payout_provider_supports(
  p_provider_id uuid,
  p_currency_code char(3),
  p_capability text
) returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  row_found public.payout_provider_capabilities;
begin
  select * into row_found from public.payout_provider_capabilities c
   where c.payout_provider_id = p_provider_id and c.currency_code = p_currency_code;
  if row_found.payout_provider_id is null then
    return false; -- no recorded capability means no capability
  end if;
  return case p_capability
    when 'payout' then row_found.supports_payout
    when 'destination_validation' then row_found.supports_destination_validation
    when 'destination_registration' then row_found.supports_destination_registration
    when 'cancel' then row_found.supports_cancel
    when 'reverse' then row_found.supports_reverse
    when 'status_lookup' then row_found.supports_status_lookup
    when 'provider_idempotency' then row_found.supports_provider_idempotency
    when 'webhooks' then row_found.supports_webhooks
    else false
  end;
end;
$$;
comment on function public.payout_provider_supports(uuid, char, text) is
  'Fail-closed capability lookup: an unrecorded provider, currency or capability answers false.';

create or replace function public.payout_provider_is_eligible(
  p_provider_id uuid,
  p_currency_code char(3)
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.payout_providers p
      join public.payout_provider_capabilities c
        on c.payout_provider_id = p.id and c.currency_code = p_currency_code
     where p.id = p_provider_id
       and p.is_enabled
       and c.supports_payout
       and (c.supports_provider_idempotency or c.supports_status_lookup)
  );
$$;
comment on function public.payout_provider_is_eligible(uuid, char) is
  'Whether this provider may be paid out through in this currency: enabled, capable, and retry-safe. Everything unrecorded answers false.';

-- ---------------------------------------------------------------------------------------------------
-- Payout destinations
-- ---------------------------------------------------------------------------------------------------
create table public.payout_destinations (
  id uuid primary key default gen_random_uuid(),
  seller_user_id uuid not null references public.seller_profiles (user_id) on delete restrict,
  payout_provider_id uuid not null references public.payout_providers (id) on delete restrict,
  currency_code char(3) not null references public.currencies (code) on delete restrict,
  country_code char(2) references public.countries (code) on delete restrict,
  destination_kind text not null,
  label text,
  masked_value text not null,
  vault_secret_id uuid,
  provider_token text,
  verification_status text not null default 'unverified',
  verified_at timestamptz,
  rejection_reason text,
  is_default boolean not null default false,
  status text not null default 'active',
  last_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payout_destinations_kind_allowed check (destination_kind in ('bank_account', 'wallet', 'card', 'provider_token')),
  constraint payout_destinations_masked_value_length check (length(btrim(masked_value)) between 1 and 64),
  -- Details are held in Vault or replaced by a provider token — one or the other, never neither and
  -- never both, and never as a readable column on this table.
  constraint payout_destinations_secret_is_held_once check (
    (vault_secret_id is not null) <> (provider_token is not null)
  ),
  constraint payout_destinations_verification_status_allowed check (
    verification_status in ('unverified', 'pending', 'verified', 'rejected')
  ),
  constraint payout_destinations_verified_has_time check ((verification_status = 'verified') = (verified_at is not null)),
  constraint payout_destinations_rejected_has_reason check (
    verification_status <> 'rejected' or length(btrim(rejection_reason)) > 0
  ),
  constraint payout_destinations_status_allowed check (status in ('active', 'disabled')),
  constraint payout_destinations_default_is_usable check (
    not is_default or (status = 'active' and verification_status = 'verified')
  ),
  constraint payout_destinations_label_length check (label is null or length(btrim(label)) between 1 and 60),
  unique (id, currency_code)
);
comment on table public.payout_destinations is
  'Where a seller is paid. Only the masked value is readable here; the details live in Vault or as a provider token. Changes need a step-up grant and aal2, are audited and notify the seller.';
comment on column public.payout_destinations.vault_secret_id is
  'The Supabase Vault secret holding the encrypted details. Vault owns that row, so there is deliberately no foreign key to it.';
comment on column public.payout_destinations.masked_value is
  'The only display form, e.g. the last four digits. Never the full number.';
create unique index payout_destinations_one_default on public.payout_destinations (seller_user_id, currency_code)
  where is_default;
create index payout_destinations_seller on public.payout_destinations (seller_user_id, currency_code, status);
create index payout_destinations_provider on public.payout_destinations (payout_provider_id);
create trigger payout_destinations_set_updated_at before update on public.payout_destinations
  for each row execute function app_private.tg_set_updated_at();
create trigger payout_destinations_audit after insert or update or delete on public.payout_destinations
  for each row execute function audit.tg_record_change('provider_token', 'vault_secret_id');

create or replace function app_private.tg_payout_destinations_changed() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE' then
    new.last_changed_at := now();
  end if;

  perform public.enqueue_outbox_event(
    'payout_destination', new.id::text,
    case tg_op when 'INSERT' then 'payout_destination.added' else 'payout_destination.changed' end,
    jsonb_build_object(
      'payout_destination_id', new.id,
      'seller_user_id', new.seller_user_id,
      'currency_code', new.currency_code,
      'masked_value', new.masked_value
    )
  );
  return new;
end;
$$;
comment on function app_private.tg_payout_destinations_changed() is
  'Stamps the change time and publishes the event the Notifications module turns into the seller''s warning that their payout details moved. The payload carries the masked value only.';

create trigger payout_destinations_changed before insert or update on public.payout_destinations
  for each row execute function app_private.tg_payout_destinations_changed();

create or replace function public.seller_payout_destination(
  p_seller_user_id uuid,
  p_currency_code char(3)
) returns public.payout_destinations
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select d.*
    from public.payout_destinations d
   where d.seller_user_id = p_seller_user_id
     and d.currency_code = p_currency_code
     and d.status = 'active'
     and d.verification_status = 'verified'
   order by d.is_default desc, d.verified_at desc
   limit 1;
$$;
comment on function public.seller_payout_destination(uuid, char) is
  'The destination a payout in this currency would use: the seller''s default if there is one, otherwise the most recently verified. Nothing unverified or disabled is ever returned.';

-- ---------------------------------------------------------------------------------------------------
-- Payouts
-- ---------------------------------------------------------------------------------------------------
create table public.payouts (
  id uuid primary key default gen_random_uuid(),
  currency_code char(3) not null,
  seller_user_id uuid not null,
  withdrawal_id uuid not null,
  payout_provider_id uuid not null references public.payout_providers (id) on delete restrict,
  payout_destination_id uuid not null,
  amount_minor bigint not null,
  status text not null default 'pending',
  idempotency_key text not null,
  provider_payout_ref text,
  destination_masked_snapshot text not null,
  failure_code text,
  ledger_journal_id uuid references public.ledger_journals (id) on delete restrict,
  created_at timestamptz not null default now(),
  processing_at timestamptz,
  paid_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  reversed_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (withdrawal_id, currency_code) references public.withdrawals (id, currency_code) on delete restrict,
  foreign key (seller_user_id, currency_code) references public.seller_balances (seller_user_id, currency_code) on delete restrict,
  foreign key (payout_destination_id, currency_code) references public.payout_destinations (id, currency_code) on delete restrict,
  constraint payouts_amount_positive check (amount_minor > 0),
  constraint payouts_status_allowed check (status in ('pending', 'processing', 'paid', 'failed', 'cancelled', 'reversed')),
  constraint payouts_idempotency_key_length check (length(idempotency_key) between 8 and 255),
  constraint payouts_paid_has_time check ((status in ('paid', 'reversed')) = (paid_at is not null)),
  constraint payouts_failed_has_time check ((status = 'failed') = (failed_at is not null)),
  constraint payouts_cancelled_has_time check ((status = 'cancelled') = (cancelled_at is not null)),
  constraint payouts_reversed_has_time check ((status = 'reversed') = (reversed_at is not null)),
  constraint payouts_failure_code_format check (failure_code is null or failure_code ~ '^[a-z][a-z0-9_.]*$'),
  -- One payout per withdrawal, which is the other half of "no payout without an approved withdrawal".
  unique (withdrawal_id),
  unique (id, currency_code)
);
comment on table public.payouts is
  'One payout per withdrawal, created only from an approved withdrawal. `idempotency_key` is our reference: it is unique per provider, so a worker retry either reaches the same payout or none at all (C10).';
comment on column public.payouts.destination_masked_snapshot is
  'The masked destination as it read when the payout was created, so the record still tells the truth if the seller changes their details afterwards.';
create unique index payouts_provider_idempotency on public.payouts (payout_provider_id, idempotency_key);
create unique index payouts_provider_ref on public.payouts (payout_provider_id, provider_payout_ref)
  where provider_payout_ref is not null;
create index payouts_seller on public.payouts (seller_user_id, currency_code, created_at desc);
create index payouts_open on public.payouts (status, created_at) where status in ('pending', 'processing');
create trigger payouts_set_updated_at before update on public.payouts
  for each row execute function app_private.tg_set_updated_at();
create trigger payouts_audit after insert or update or delete on public.payouts
  for each row execute function audit.tg_record_change('failure_code');

create or replace function app_private.tg_payouts_transition() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.idempotency_key <> new.idempotency_key then
    raise exception 'the idempotency key of a payout is immutable' using errcode = 'restrict_violation';
  end if;
  if old.amount_minor <> new.amount_minor then
    raise exception 'the amount of a payout is immutable' using errcode = 'restrict_violation';
  end if;
  if old.status = new.status then
    return new;
  end if;

  if not (
    (old.status = 'pending' and new.status in ('processing', 'paid', 'failed', 'cancelled'))
    or (old.status = 'processing' and new.status in ('paid', 'failed', 'cancelled'))
    or (old.status = 'paid' and new.status = 'reversed')
  ) then
    raise exception 'a payout cannot move from % to %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger payouts_transition before update on public.payouts
  for each row execute function app_private.tg_payouts_transition();

-- ---------------------------------------------------------------------------------------------------
-- Provider transactions and webhook receipts
-- ---------------------------------------------------------------------------------------------------
create table public.payout_transactions (
  id uuid primary key default gen_random_uuid(),
  currency_code char(3) not null references public.currencies (code) on delete restrict,
  payout_provider_id uuid not null references public.payout_providers (id) on delete restrict,
  payout_id uuid references public.payouts (id) on delete set null,
  kind text not null,
  provider_reference text not null,
  amount_minor bigint not null,
  normalized_status text not null,
  provider_status text,
  occurred_at timestamptz not null default now(),
  recorded_at timestamptz not null default now(),
  constraint payout_transactions_kind_allowed check (kind in ('payout', 'cancel', 'reversal')),
  constraint payout_transactions_amount_positive check (amount_minor > 0),
  constraint payout_transactions_status_allowed check (
    normalized_status in ('pending', 'processing', 'succeeded', 'failed', 'cancelled')
  ),
  unique (payout_provider_id, provider_reference, kind)
);
comment on table public.payout_transactions is
  'What the provider says happened, normalised and append-only. 0023 reconciles these against the clearing accounts once B1-C closes.';
create index payout_transactions_payout on public.payout_transactions (payout_id, occurred_at);
create trigger payout_transactions_append_only before update or delete on public.payout_transactions
  for each row execute function app_private.tg_reject_write();

create table public.payout_events (
  id uuid primary key default gen_random_uuid(),
  payout_provider_id uuid not null references public.payout_providers (id) on delete restrict,
  event_key text not null,
  event_type text not null,
  payload_digest bytea not null,
  payout_id uuid references public.payouts (id) on delete set null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_error_type text,
  constraint payout_events_key_length check (length(event_key) between 1 and 255),
  constraint payout_events_type_length check (length(event_type) between 1 and 120),
  constraint payout_events_error_type_format check (processing_error_type is null or processing_error_type ~ '^[A-Za-z][A-Za-z0-9_]*$'),
  unique (payout_provider_id, event_key)
);
comment on table public.payout_events is
  'Verified payout webhook receipts. The unique (provider, event key) is the replay protection (C19); only a digest of the body is kept, never the body.';
create index payout_events_unprocessed on public.payout_events (received_at) where processed_at is null;

create or replace function app_private.record_payout_event(
  p_provider_id uuid,
  p_event_key text,
  p_event_type text,
  p_payload_digest bytea,
  p_payout_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  new_id uuid;
begin
  insert into public.payout_events (payout_provider_id, event_key, event_type, payload_digest, payout_id)
  values (p_provider_id, p_event_key, p_event_type, p_payload_digest, p_payout_id)
  on conflict (payout_provider_id, event_key) do nothing
  returning id into new_id;
  return new_id;
end;
$$;
comment on function app_private.record_payout_event(uuid, text, text, bytea, uuid) is
  'Stores a verified payout webhook receipt. Returns NULL when the provider has already sent this event, so a replay changes nothing (C19).';

create or replace function app_private.complete_payout_event(p_event_id uuid, p_error_type text default null) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated integer;
begin
  update public.payout_events
     set processed_at = now(), processing_error_type = p_error_type
   where id = p_event_id and processed_at is null;
  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- Reversals
-- ---------------------------------------------------------------------------------------------------
create table public.payout_reversals (
  id uuid primary key default gen_random_uuid(),
  currency_code char(3) not null,
  payout_id uuid not null,
  amount_minor bigint not null,
  reason text not null,
  status text not null default 'pending',
  idempotency_key text not null,
  provider_reference text,
  ledger_journal_id uuid references public.ledger_journals (id) on delete restrict,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  succeeded_at timestamptz,
  failed_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (payout_id, currency_code) references public.payouts (id, currency_code) on delete restrict,
  constraint payout_reversals_amount_positive check (amount_minor > 0),
  constraint payout_reversals_reason_length check (length(btrim(reason)) between 1 and 500),
  constraint payout_reversals_status_allowed check (status in ('pending', 'succeeded', 'failed')),
  constraint payout_reversals_idempotency_key_length check (length(idempotency_key) between 8 and 255),
  constraint payout_reversals_succeeded_has_time check ((status = 'succeeded') = (succeeded_at is not null)),
  constraint payout_reversals_failed_has_time check ((status = 'failed') = (failed_at is not null)),
  constraint payout_reversals_succeeded_has_journal check (status <> 'succeeded' or ledger_journal_id is not null),
  unique (payout_id)
);
comment on table public.payout_reversals is
  'A payout that came back. A succeeded reversal posts the mirror journal — payout clearing is debited and the seller''s available balance is credited — so the history is corrected by addition, never by editing the payout.';
create unique index payout_reversals_idempotency on public.payout_reversals (idempotency_key);
create trigger payout_reversals_set_updated_at before update on public.payout_reversals
  for each row execute function app_private.tg_set_updated_at();
create trigger payout_reversals_audit after insert or update or delete on public.payout_reversals
  for each row execute function audit.tg_record_change('reason');

create or replace function app_private.tg_payout_reversals_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  payout public.payouts;
begin
  if tg_op = 'INSERT' then
    select * into payout from public.payouts p where p.id = new.payout_id;
    if payout.status <> 'paid' then
      raise exception 'only a paid payout can be reversed' using errcode = 'restrict_violation';
    end if;
    if new.amount_minor > payout.amount_minor then
      raise exception 'a reversal can never exceed the payout' using errcode = 'restrict_violation';
    end if;
    if not public.payout_provider_supports(payout.payout_provider_id, payout.currency_code, 'reverse') then
      raise exception 'this payout provider does not support reversals' using errcode = 'restrict_violation';
    end if;
    return new;
  end if;

  if old.status <> 'pending' and new.status <> old.status then
    raise exception 'a settled reversal is final' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger payout_reversals_guard before insert or update on public.payout_reversals
  for each row execute function app_private.tg_payout_reversals_guard();

-- ---------------------------------------------------------------------------------------------------
-- Creating and settling a payout
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.create_payout(
  p_withdrawal_id uuid,
  p_payout_provider_id uuid,
  p_payout_destination_id uuid,
  p_idempotency_key text
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  withdrawal public.withdrawals;
  destination public.payout_destinations;
  existing_id uuid;
  new_payout_id uuid;
begin
  -- The row lock is what makes two workers racing on the same withdrawal produce one payout.
  select * into withdrawal from public.withdrawals w where w.id = p_withdrawal_id for update;
  if withdrawal.id is null then
    raise exception 'withdrawal % does not exist', p_withdrawal_id using errcode = 'no_data_found';
  end if;

  select p.id into existing_id from public.payouts p where p.withdrawal_id = p_withdrawal_id;
  if existing_id is not null then
    return existing_id; -- the caller is retrying (C10)
  end if;

  -- No payout without an approved withdrawal.
  if withdrawal.status <> 'approved' then
    raise exception 'withdrawal % is % and cannot be paid out', p_withdrawal_id, withdrawal.status
      using errcode = 'restrict_violation';
  end if;

  -- D26: a dispute holding this seller's funds stops the money leaving.
  if public.seller_funds_are_frozen(withdrawal.seller_user_id) then
    raise exception 'an open dispute is holding this seller''s funds' using errcode = 'restrict_violation';
  end if;

  if not public.payout_provider_is_eligible(p_payout_provider_id, withdrawal.currency_code) then
    raise exception 'payout provider % is not eligible for %', p_payout_provider_id, withdrawal.currency_code
      using errcode = 'restrict_violation';
  end if;

  select * into destination from public.payout_destinations d where d.id = p_payout_destination_id;
  if destination.id is null
     or destination.seller_user_id <> withdrawal.seller_user_id
     or destination.currency_code <> withdrawal.currency_code
     or destination.payout_provider_id <> p_payout_provider_id
     or destination.status <> 'active'
     or destination.verification_status <> 'verified' then
    raise exception 'destination % cannot receive this payout', p_payout_destination_id
      using errcode = 'restrict_violation';
  end if;
  if not (destination.destination_kind = any (
        select unnest(c.destination_kinds)
          from public.payout_provider_capabilities c
         where c.payout_provider_id = p_payout_provider_id and c.currency_code = withdrawal.currency_code
      )) then
    raise exception 'this provider does not accept % destinations in %',
      destination.destination_kind, withdrawal.currency_code using errcode = 'restrict_violation';
  end if;

  insert into public.payouts (
    currency_code, seller_user_id, withdrawal_id, payout_provider_id, payout_destination_id,
    amount_minor, idempotency_key, destination_masked_snapshot
  )
  values (
    withdrawal.currency_code, withdrawal.seller_user_id, p_withdrawal_id, p_payout_provider_id,
    p_payout_destination_id, withdrawal.amount_minor, p_idempotency_key, destination.masked_value
  )
  returning id into new_payout_id;

  -- `approved --> processing: payout created`. The reservation stays reserved; nothing moves yet.
  perform app_private.transition_withdrawal(p_withdrawal_id, 'processing', null, 'payout created');

  perform public.enqueue_outbox_event(
    'payout', new_payout_id::text, 'payout.created',
    jsonb_build_object('payout_id', new_payout_id, 'withdrawal_id', p_withdrawal_id,
                       'seller_user_id', withdrawal.seller_user_id, 'currency_code', withdrawal.currency_code,
                       'amount_minor', withdrawal.amount_minor)
  );
  return new_payout_id;
end;
$$;
comment on function app_private.create_payout(uuid, uuid, uuid, text) is
  'Creates the one payout an approved withdrawal is allowed, after the provider, the destination and the dispute freeze have all agreed, and moves the withdrawal to processing.';

create or replace function app_private.settle_payout(
  p_payout_id uuid,
  p_status text,
  p_provider_payout_ref text default null,
  p_failure_code text default null
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  payout public.payouts;
begin
  if p_status not in ('processing', 'paid', 'failed', 'cancelled') then
    raise exception 'unknown payout settlement status %', p_status using errcode = 'invalid_parameter_value';
  end if;

  select * into payout from public.payouts p where p.id = p_payout_id for update;
  if payout.id is null then
    raise exception 'payout % does not exist', p_payout_id using errcode = 'no_data_found';
  end if;

  -- C10: the provider re-reporting an outcome we already recorded changes nothing.
  if payout.status = p_status then
    return format('already_%s', p_status);
  end if;
  if payout.status in ('paid', 'failed', 'cancelled', 'reversed') then
    raise exception 'payout % is already %', p_payout_id, payout.status using errcode = 'restrict_violation';
  end if;

  if p_provider_payout_ref is not null then
    insert into public.payout_transactions (
      currency_code, payout_provider_id, payout_id, kind, provider_reference, amount_minor, normalized_status
    )
    values (
      payout.currency_code, payout.payout_provider_id, payout.id,
      case when p_status = 'cancelled' then 'cancel' else 'payout' end,
      p_provider_payout_ref, payout.amount_minor,
      case p_status when 'paid' then 'succeeded' else p_status end
    )
    on conflict (payout_provider_id, provider_reference, kind) do nothing;
  end if;

  update public.payouts p
     set status = p_status,
         provider_payout_ref = coalesce(p_provider_payout_ref, p.provider_payout_ref),
         processing_at = case when p_status = 'processing' then now() else p.processing_at end,
         paid_at = case when p_status = 'paid' then now() else p.paid_at end,
         failed_at = case when p_status = 'failed' then now() else p.failed_at end,
         cancelled_at = case when p_status = 'cancelled' then now() else p.cancelled_at end,
         failure_code = case when p_status = 'failed' then p_failure_code else p.failure_code end
   where p.id = p_payout_id;

  -- The withdrawal follows the payout, and `transition_withdrawal` posts the journal, so the ledger and
  -- the withdrawal status cannot disagree: `paid` spends the reservation, anything else releases it.
  if p_status = 'paid' then
    perform app_private.transition_withdrawal(payout.withdrawal_id, 'paid', null, 'payout settled');
    update public.payouts p
       set ledger_journal_id = w.settlement_journal_id
      from public.withdrawals w
     where p.id = p_payout_id and w.id = payout.withdrawal_id;
  elsif p_status in ('failed', 'cancelled') then
    perform app_private.transition_withdrawal(
      payout.withdrawal_id, 'failed', null, coalesce(p_failure_code, p_status)
    );
  end if;

  perform public.enqueue_outbox_event(
    'payout', p_payout_id::text, format('payout.%s', p_status),
    jsonb_build_object('payout_id', p_payout_id, 'withdrawal_id', payout.withdrawal_id, 'status', p_status)
  );
  return p_status;
end;
$$;
comment on function app_private.settle_payout(uuid, text, text, text) is
  'The one path to a settled payout. Repeating an outcome is a no-op (C10); a terminal payout can never be re-settled, and the withdrawal always follows.';

create or replace function app_private.settle_payout_reversal(
  p_reversal_id uuid,
  p_status text,
  p_provider_reference text default null
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  reversal public.payout_reversals;
  payout public.payouts;
  journal_id uuid;
begin
  if p_status not in ('succeeded', 'failed') then
    raise exception 'a reversal settles as succeeded or failed, not %', p_status using errcode = 'invalid_parameter_value';
  end if;

  select * into reversal from public.payout_reversals r where r.id = p_reversal_id for update;
  if reversal.id is null then
    raise exception 'payout reversal % does not exist', p_reversal_id using errcode = 'no_data_found';
  end if;
  if reversal.status = p_status then
    return format('already_%s', p_status);
  end if;

  select * into payout from public.payouts p where p.id = reversal.payout_id for update;

  if p_status = 'succeeded' then
    -- The mirror of the payout journal: the obligation leaves payout clearing and the seller is owed
    -- the money again.
    journal_id := app_private.post_ledger_journal(
      'adjustment',
      reversal.currency_code,
      jsonb_build_array(
        jsonb_build_object('account_type', 'payout_clearing', 'direction', 'debit',
                           'amount_minor', reversal.amount_minor, 'memo', 'payout reversed'),
        jsonb_build_object('account_type', 'seller_available', 'seller_user_id', payout.seller_user_id,
                           'direction', 'credit', 'amount_minor', reversal.amount_minor,
                           'memo', 'payout reversed')
      ),
      'payout', payout.id::text,
      format('payout:%s:reversed', payout.id),
      'Payout reversed'
    );

    insert into public.payout_transactions (
      currency_code, payout_provider_id, payout_id, kind, provider_reference, amount_minor, normalized_status
    )
    values (
      reversal.currency_code, payout.payout_provider_id, payout.id, 'reversal',
      coalesce(p_provider_reference, format('reversal:%s', reversal.id)), reversal.amount_minor, 'succeeded'
    )
    on conflict (payout_provider_id, provider_reference, kind) do nothing;

    update public.payouts set status = 'reversed', reversed_at = now() where id = payout.id;
  end if;

  update public.payout_reversals r
     set status = p_status,
         provider_reference = coalesce(p_provider_reference, r.provider_reference),
         ledger_journal_id = coalesce(journal_id, r.ledger_journal_id),
         succeeded_at = case when p_status = 'succeeded' then now() else r.succeeded_at end,
         failed_at = case when p_status = 'failed' then now() else r.failed_at end
   where r.id = p_reversal_id;

  perform public.enqueue_outbox_event(
    'payout', payout.id::text, format('payout.reversal_%s', p_status),
    jsonb_build_object('payout_id', payout.id, 'payout_reversal_id', p_reversal_id, 'status', p_status)
  );
  return p_status;
end;
$$;
comment on function app_private.settle_payout_reversal(uuid, text, text) is
  'Settles a reversal. On success it posts the mirror journal and marks the payout reversed; the payout row itself is never rewritten beyond that terminal move.';

-- ---------------------------------------------------------------------------------------------------
-- Currency dependencies (D16)
-- ---------------------------------------------------------------------------------------------------
select app_private.register_currency_dependency(
  'payout_provider_capabilities.currency_code', 'public', 'payout_provider_capabilities', 'currency_code',
  'payout provider capabilities recorded for the currency'
);
select app_private.register_currency_dependency(
  'payout_destinations.currency_code', 'public', 'payout_destinations', 'currency_code',
  'active payout destinations in the currency',
  $$status = 'active'$$
);
select app_private.register_currency_dependency(
  'payouts.currency_code', 'public', 'payouts', 'currency_code',
  'payouts in flight in the currency',
  $$status in ('pending', 'processing')$$
);
select app_private.register_currency_dependency(
  'payout_reversals.currency_code', 'public', 'payout_reversals', 'currency_code',
  'payout reversals still open in the currency',
  $$status = 'pending'$$
);

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table public.payout_providers enable row level security;
alter table public.payout_provider_capabilities enable row level security;
alter table public.payout_destinations enable row level security;
alter table public.payouts enable row level security;
alter table public.payout_transactions enable row level security;
alter table public.payout_events enable row level security;
alter table public.payout_reversals enable row level security;

create policy payout_providers_public_read on public.payout_providers for select to authenticated
  using (is_enabled);
create policy payout_providers_admin_write on public.payout_providers for all to authenticated
  using (public.has_permission('payouts.provider.manage') and public.is_aal2())
  with check (public.has_permission('payouts.provider.manage') and public.is_aal2());

create policy payout_provider_capabilities_read on public.payout_provider_capabilities for select to authenticated
  using (exists (select 1 from public.payout_providers p where p.id = payout_provider_id and p.is_enabled));
create policy payout_provider_capabilities_admin_write on public.payout_provider_capabilities for all to authenticated
  using (public.has_permission('payouts.provider.manage') and public.is_aal2())
  with check (public.has_permission('payouts.provider.manage') and public.is_aal2());

-- A seller sees their own destinations, but changing one needs a fresh step-up grant at aal2.
create policy payout_destinations_owner_read on public.payout_destinations for select to authenticated
  using (seller_user_id = public.current_user_id());
create policy payout_destinations_staff_read on public.payout_destinations for select to authenticated
  using (public.has_permission('payouts.destination.read'));
create policy payout_destinations_owner_insert on public.payout_destinations for insert to authenticated
  with check (
    seller_user_id = public.current_user_id()
    and public.is_aal2()
    and public.has_step_up_grant('payout_details')
  );
create policy payout_destinations_owner_update on public.payout_destinations for update to authenticated
  using (
    seller_user_id = public.current_user_id()
    and public.is_aal2()
    and public.has_step_up_grant('payout_details')
  )
  with check (
    seller_user_id = public.current_user_id()
    and public.is_aal2()
    and public.has_step_up_grant('payout_details')
  );

create policy payouts_seller_read on public.payouts for select to authenticated
  using (seller_user_id = public.current_user_id());
create policy payouts_staff_read on public.payouts for select to authenticated
  using (public.has_permission('payouts.payout.read'));

-- Provider transactions and webhook receipts are server-only: no policy, no grant.

create policy payout_reversals_staff_read on public.payout_reversals for select to authenticated
  using (public.has_permission('payouts.payout.read'));
create policy payout_reversals_staff_write on public.payout_reversals for all to authenticated
  using (public.has_permission('payouts.reversal.manage') and public.is_aal2())
  with check (public.has_permission('payouts.reversal.manage') and public.is_aal2());

grant select, insert, update, delete on public.payout_providers to authenticated;
grant select, insert, update, delete on public.payout_provider_capabilities to authenticated;
grant select, insert, update on public.payout_destinations to authenticated;
grant select on public.payouts to authenticated;
grant select, insert, update on public.payout_reversals to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function
  public.payout_provider_supports(uuid, char, text),
  public.payout_provider_is_eligible(uuid, char),
  public.seller_payout_destination(uuid, char)
  to authenticated;

grant execute on function
  public.payout_provider_supports(uuid, char, text),
  public.payout_provider_is_eligible(uuid, char),
  public.seller_payout_destination(uuid, char),
  app_private.create_payout(uuid, uuid, uuid, text),
  app_private.settle_payout(uuid, text, text, text),
  app_private.settle_payout_reversal(uuid, text, text),
  app_private.record_payout_event(uuid, text, text, bytea, uuid),
  app_private.complete_payout_event(uuid, text)
  to app_system, app_worker;
