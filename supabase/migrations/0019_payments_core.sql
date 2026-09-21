-- 0019 — Payments core: providers, capabilities, payments, attempts, provider transactions, events,
-- refunds and disputes (v5.2 migration plan).
--
-- Everything here is provider-neutral. No adapter exists until B1-A closes and none of the candidate
-- gateways is seeded or assumed; `payment_providers` starts empty and a provider is added later by its
-- own migration, disabled, with capabilities taken from its official documentation.
--
-- Normalised attempt statuses are `pending`, `requires_action`, `succeeded`, `failed`, `cancelled`,
-- `expired`; next actions are `redirect`, `embedded`, `reference_code`, `none`. Status is confirmed only
-- by a verified webhook or a server-side status lookup — a return URL is never trusted, so nothing in
-- this schema can be moved to `succeeded` by a browser.
--
-- Webhooks (C19): the raw body is verified, then stored in `payment_events`, which is unique on
-- (provider, event key). That unique key IS the replay protection: a redelivered webhook inserts
-- nothing and the endpoint still answers 2xx.
--
-- D19: several attempts may exist for one payment, but only one can ever fulfil the checkout. That is
-- enforced by `checkouts.fulfilled_attempt_id`, whose foreign key is added here now that
-- `payment_attempts` exists.
--
-- NOT BUILT HERE, on purpose: `payment_method_capabilities` is conditional on D18 and `fee_schedules` on
-- D20; both items are still BLOCKED, and conditional tables are not built until they close.

-- ---------------------------------------------------------------------------------------------------
-- Providers and capabilities
-- ---------------------------------------------------------------------------------------------------
create table public.payment_providers (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  display_name text not null,
  is_enabled boolean not null default false,
  is_default boolean not null default false,
  priority integer not null default 0,
  documentation_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_providers_key_format check (key ~ '^[a-z][a-z0-9_]*$'),
  constraint payment_providers_display_name_length check (length(btrim(display_name)) between 1 and 80),
  constraint payment_providers_default_is_enabled check (not is_default or is_enabled),
  constraint payment_providers_documentation_url_shape check (documentation_url is null or documentation_url ~ '^https://')
);
comment on table public.payment_providers is
  'Payment gateways, provider-neutral. Empty until B1-A closes; a provider arrives disabled, in its own migration. Credentials never live here.';
create unique index payment_providers_key on public.payment_providers (key);
create unique index payment_providers_one_default on public.payment_providers ((is_default)) where is_default;
create trigger payment_providers_set_updated_at before update on public.payment_providers
  for each row execute function app_private.tg_set_updated_at();
create trigger payment_providers_audit after insert or update or delete on public.payment_providers
  for each row execute function audit.tg_record_change();

create table public.payment_provider_capabilities (
  payment_provider_id uuid not null references public.payment_providers (id) on delete cascade,
  currency_code char(3) not null references public.currencies (code) on delete restrict,
  supports_charge boolean not null default false,
  supports_refund boolean not null default false,
  supports_partial_refund boolean not null default false,
  supports_cancel boolean not null default false,
  supports_status_lookup boolean not null default false,
  supports_provider_idempotency boolean not null default false,
  supports_webhooks boolean not null default false,
  amount_format text not null default 'minor',
  amount_decimal_places smallint,
  min_amount_minor bigint,
  max_amount_minor bigint,
  evidence_url text not null,
  recorded_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (payment_provider_id, currency_code),
  constraint payment_provider_capabilities_amount_format_allowed check (amount_format in ('minor', 'major_decimal')),
  constraint payment_provider_capabilities_decimal_places_range check (amount_decimal_places is null or amount_decimal_places between 0 and 4),
  constraint payment_provider_capabilities_amounts_positive check (
    (min_amount_minor is null or min_amount_minor >= 0)
    and (max_amount_minor is null or max_amount_minor >= 0)
  ),
  constraint payment_provider_capabilities_amount_order check (
    min_amount_minor is null or max_amount_minor is null or max_amount_minor >= min_amount_minor
  ),
  constraint payment_provider_capabilities_partial_needs_refund check (not supports_partial_refund or supports_refund),
  constraint payment_provider_capabilities_evidence_url_shape check (evidence_url ~ '^https://')
);
comment on table public.payment_provider_capabilities is
  'What a provider can actually do, per currency, taken from its official documentation — `evidence_url` records where. Adapters convert minor units using `amount_format`.';
create trigger payment_provider_capabilities_set_updated_at before update on public.payment_provider_capabilities
  for each row execute function app_private.tg_set_updated_at();

create or replace function public.payment_provider_supports(
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
  row_found public.payment_provider_capabilities;
begin
  select * into row_found from public.payment_provider_capabilities c
   where c.payment_provider_id = p_provider_id and c.currency_code = p_currency_code;
  if row_found.payment_provider_id is null then
    return false; -- no recorded capability means no capability
  end if;
  return case p_capability
    when 'charge' then row_found.supports_charge
    when 'refund' then row_found.supports_refund
    when 'partial_refund' then row_found.supports_partial_refund
    when 'cancel' then row_found.supports_cancel
    when 'status_lookup' then row_found.supports_status_lookup
    when 'provider_idempotency' then row_found.supports_provider_idempotency
    when 'webhooks' then row_found.supports_webhooks
    else false
  end;
end;
$$;
comment on function public.payment_provider_supports(uuid, char, text) is
  'Fail-closed capability lookup: an unrecorded provider, currency or capability answers false.';

-- ---------------------------------------------------------------------------------------------------
-- Payments and attempts
-- ---------------------------------------------------------------------------------------------------
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  currency_code char(3) not null,
  checkout_id uuid not null,
  buyer_user_id uuid not null references auth.users (id) on delete restrict,
  payment_provider_id uuid references public.payment_providers (id) on delete restrict,
  amount_minor bigint not null,
  refunded_amount_minor bigint not null default 0,
  status text not null default 'pending',
  paid_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (checkout_id, currency_code) references public.checkouts (id, currency_code) on delete restrict,
  constraint payments_amount_positive check (amount_minor > 0),
  constraint payments_refunded_within_amount check (refunded_amount_minor between 0 and amount_minor),
  constraint payments_status_allowed check (status in ('pending', 'authorized', 'paid', 'partially_refunded', 'refunded', 'failed', 'cancelled', 'expired')),
  constraint payments_paid_has_time check ((status in ('paid', 'partially_refunded', 'refunded')) = (paid_at is not null)),
  constraint payments_cancelled_has_time check ((status = 'cancelled') = (cancelled_at is not null)),
  constraint payments_refund_status_matches check (
    case
      when status = 'refunded' then refunded_amount_minor = amount_minor
      when status = 'partially_refunded' then refunded_amount_minor > 0 and refunded_amount_minor < amount_minor
      else true
    end
  ),
  unique (checkout_id),
  unique (id, currency_code)
);
comment on table public.payments is
  'One payment per checkout. `status` is only ever moved by a verified webhook or a server-side status lookup, never by a return URL.';
create index payments_buyer on public.payments (buyer_user_id, created_at desc);
create index payments_provider on public.payments (payment_provider_id, status);
create trigger payments_set_updated_at before update on public.payments
  for each row execute function app_private.tg_set_updated_at();

create table public.payment_attempts (
  id uuid primary key default gen_random_uuid(),
  currency_code char(3) not null,
  payment_id uuid not null,
  payment_provider_id uuid not null references public.payment_providers (id) on delete restrict,
  attempt_number integer not null,
  amount_minor bigint not null,
  status text not null default 'pending',
  next_action text not null default 'none',
  provider_payment_ref text,
  idempotency_key text not null,
  method_code text,
  expires_at timestamptz,
  succeeded_at timestamptz,
  failed_at timestamptz,
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (payment_id, currency_code) references public.payments (id, currency_code) on delete cascade,
  constraint payment_attempts_number_positive check (attempt_number >= 1),
  constraint payment_attempts_amount_positive check (amount_minor > 0),
  constraint payment_attempts_status_allowed check (status in ('pending', 'requires_action', 'succeeded', 'failed', 'cancelled', 'expired')),
  constraint payment_attempts_next_action_allowed check (next_action in ('redirect', 'embedded', 'reference_code', 'none')),
  constraint payment_attempts_succeeded_has_time check ((status = 'succeeded') = (succeeded_at is not null)),
  -- One-way on purpose: a late success moves an expired attempt to `succeeded` (D18) and the time it
  -- expired stays on the record.
  constraint payment_attempts_failed_has_time check (status not in ('failed', 'expired') or failed_at is not null),
  constraint payment_attempts_failure_code_format check (failure_code is null or failure_code ~ '^[a-z][a-z0-9_.]*$'),
  constraint payment_attempts_idempotency_key_length check (length(idempotency_key) between 8 and 255),
  unique (payment_id, attempt_number),
  unique (id, currency_code)
);
comment on table public.payment_attempts is
  'Several attempts may exist for one payment (D19). Only one can ever fulfil the checkout: checkouts.fulfilled_attempt_id decides that, under a row lock.';
comment on column public.payment_attempts.idempotency_key is
  'Our key for this attempt, sent to the provider when it supports provider idempotency (C10); unique per provider either way.';
create unique index payment_attempts_provider_idempotency on public.payment_attempts (payment_provider_id, idempotency_key);
create unique index payment_attempts_provider_ref on public.payment_attempts (payment_provider_id, provider_payment_ref)
  where provider_payment_ref is not null;
create index payment_attempts_open on public.payment_attempts (status, expires_at) where status in ('pending', 'requires_action');
create trigger payment_attempts_set_updated_at before update on public.payment_attempts
  for each row execute function app_private.tg_set_updated_at();

-- Now that attempts exist, the checkout's fulfilling attempt becomes a real reference (D19).
alter table public.checkouts
  add constraint checkouts_fulfilled_attempt_fkey
  foreign key (fulfilled_attempt_id) references public.payment_attempts (id) on delete restrict;

-- A succeeded attempt is final: it may never be walked back to a non-terminal state.
create or replace function app_private.tg_payment_attempts_terminal() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.status = 'succeeded' and new.status <> 'succeeded' then
    raise exception 'a succeeded payment attempt cannot change state' using errcode = 'restrict_violation';
  end if;
  if old.idempotency_key <> new.idempotency_key then
    raise exception 'the idempotency key of an attempt is immutable' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger payment_attempts_terminal before update on public.payment_attempts
  for each row execute function app_private.tg_payment_attempts_terminal();

-- ---------------------------------------------------------------------------------------------------
-- Provider transactions
-- ---------------------------------------------------------------------------------------------------
create table public.payment_provider_transactions (
  id uuid primary key default gen_random_uuid(),
  currency_code char(3) not null references public.currencies (code) on delete restrict,
  payment_provider_id uuid not null references public.payment_providers (id) on delete restrict,
  payment_attempt_id uuid references public.payment_attempts (id) on delete set null,
  payment_id uuid references public.payments (id) on delete set null,
  kind text not null,
  provider_reference text not null,
  amount_minor bigint not null,
  normalized_status text not null,
  provider_status text,
  occurred_at timestamptz not null default now(),
  recorded_at timestamptz not null default now(),
  constraint payment_provider_transactions_kind_allowed check (kind in ('charge', 'capture', 'void', 'refund', 'reversal', 'chargeback')),
  constraint payment_provider_transactions_amount_positive check (amount_minor > 0),
  constraint payment_provider_transactions_status_allowed check (
    normalized_status in ('pending', 'requires_action', 'succeeded', 'failed', 'cancelled', 'expired')
  ),
  unique (payment_provider_id, provider_reference, kind)
);
comment on table public.payment_provider_transactions is
  'What the provider says happened, normalised. The unique key makes a repeated report of the same movement a no-op.';
create index payment_provider_transactions_attempt on public.payment_provider_transactions (payment_attempt_id, occurred_at desc);
create index payment_provider_transactions_payment on public.payment_provider_transactions (payment_id, occurred_at desc);
create trigger payment_provider_transactions_append_only before update or delete on public.payment_provider_transactions
  for each row execute function app_private.tg_reject_write();

-- ---------------------------------------------------------------------------------------------------
-- Webhook events (C19: verified, stored, replay-protected, then processed)
-- ---------------------------------------------------------------------------------------------------
create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  payment_provider_id uuid not null references public.payment_providers (id) on delete restrict,
  event_key text not null,
  event_type text not null,
  payload_digest bytea not null,
  payment_id uuid references public.payments (id) on delete set null,
  payment_attempt_id uuid references public.payment_attempts (id) on delete set null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_error_type text,
  constraint payment_events_key_length check (length(event_key) between 1 and 255),
  constraint payment_events_type_length check (length(event_type) between 1 and 120),
  constraint payment_events_error_type_format check (processing_error_type is null or processing_error_type ~ '^[A-Za-z][A-Za-z0-9_]*$'),
  unique (payment_provider_id, event_key)
);
comment on table public.payment_events is
  'Verified webhook receipts. The unique key on (provider, event key) is the replay protection: a redelivery inserts nothing and the endpoint still answers 2xx. Only a digest of the body is kept, never the body.';
create index payment_events_unprocessed on public.payment_events (received_at) where processed_at is null;
create index payment_events_payment on public.payment_events (payment_id, received_at desc);

create or replace function app_private.record_payment_event(
  p_provider_id uuid,
  p_event_key text,
  p_event_type text,
  p_payload_digest bytea,
  p_payment_id uuid default null,
  p_payment_attempt_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  new_id uuid;
begin
  insert into public.payment_events (payment_provider_id, event_key, event_type, payload_digest, payment_id, payment_attempt_id)
  values (p_provider_id, p_event_key, p_event_type, p_payload_digest, p_payment_id, p_payment_attempt_id)
  on conflict (payment_provider_id, event_key) do nothing
  returning id into new_id;
  return new_id;
end;
$$;
comment on function app_private.record_payment_event(uuid, text, text, bytea, uuid, uuid) is
  'Stores a verified webhook receipt. Returns NULL when the provider has already sent this event, so a replay changes nothing (C19).';

create or replace function app_private.complete_payment_event(p_event_id uuid, p_error_type text default null) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated integer;
begin
  update public.payment_events
     set processed_at = now(), processing_error_type = p_error_type
   where id = p_event_id and processed_at is null;
  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- Refunds
-- ---------------------------------------------------------------------------------------------------
create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  currency_code char(3) not null,
  payment_id uuid not null,
  order_id uuid references public.orders (id) on delete restrict,
  amount_minor bigint not null,
  reason text not null,
  status text not null default 'requested',
  payment_provider_id uuid references public.payment_providers (id) on delete restrict,
  provider_reference text,
  idempotency_key text not null,
  requested_by uuid references auth.users (id) on delete set null,
  approved_by uuid references auth.users (id) on delete set null,
  requested_at timestamptz not null default now(),
  processed_at timestamptz,
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (payment_id, currency_code) references public.payments (id, currency_code) on delete restrict,
  constraint refunds_amount_positive check (amount_minor > 0),
  constraint refunds_reason_length check (length(btrim(reason)) between 1 and 1000),
  constraint refunds_status_allowed check (status in ('requested', 'approved', 'pending', 'succeeded', 'failed', 'cancelled')),
  constraint refunds_processed_has_time check ((status in ('succeeded', 'failed')) = (processed_at is not null)),
  constraint refunds_idempotency_key_length check (length(idempotency_key) between 8 and 255),
  unique (id, currency_code)
);
comment on table public.refunds is
  'A refund is always requested explicitly — no refund is ever automatic (D19). The provider must support refunds for the payment currency before one can be sent.';
create unique index refunds_idempotency on public.refunds (payment_provider_id, idempotency_key) where payment_provider_id is not null;
create index refunds_payment on public.refunds (payment_id, requested_at desc);
create index refunds_queue on public.refunds (status, requested_at) where status in ('requested', 'approved', 'pending');
create trigger refunds_set_updated_at before update on public.refunds
  for each row execute function app_private.tg_set_updated_at();
create trigger refunds_audit after insert or update on public.refunds
  for each row execute function audit.tg_record_change('reason');

create table public.refund_items (
  id uuid primary key default gen_random_uuid(),
  refund_id uuid not null references public.refunds (id) on delete cascade,
  order_item_id uuid not null references public.order_items (id) on delete restrict,
  quantity integer,
  amount_minor bigint not null,
  created_at timestamptz not null default now(),
  constraint refund_items_quantity_positive check (quantity is null or quantity >= 1),
  constraint refund_items_amount_positive check (amount_minor > 0),
  unique (refund_id, order_item_id)
);

-- A refund can never exceed what is left of the payment, and the provider must be able to do it.
create or replace function app_private.tg_refunds_rule() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  payment public.payments;
  already_refunded bigint;
begin
  select * into payment from public.payments p where p.id = new.payment_id;
  if payment.id is null then
    raise exception 'payment % does not exist', new.payment_id using errcode = 'foreign_key_violation';
  end if;

  select coalesce(sum(r.amount_minor), 0) into already_refunded
    from public.refunds r
   where r.payment_id = new.payment_id
     and r.status in ('requested', 'approved', 'pending', 'succeeded')
     and r.id <> new.id;

  if already_refunded + new.amount_minor > payment.amount_minor then
    raise exception 'refunding % would exceed the payment amount (% already refunded of %)',
      new.amount_minor, already_refunded, payment.amount_minor
      using errcode = 'restrict_violation';
  end if;

  if new.payment_provider_id is not null then
    if not public.payment_provider_supports(new.payment_provider_id, new.currency_code, 'refund') then
      raise exception 'the provider does not support refunds in %', new.currency_code
        using errcode = 'restrict_violation';
    end if;
    if new.amount_minor < payment.amount_minor
       and not public.payment_provider_supports(new.payment_provider_id, new.currency_code, 'partial_refund') then
      raise exception 'the provider does not support partial refunds in %', new.currency_code
        using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger refunds_rule before insert or update on public.refunds
  for each row execute function app_private.tg_refunds_rule();

-- A succeeded refund moves the payment's refunded total, and nothing else does.
create or replace function app_private.tg_refunds_apply() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  total bigint;
  payment public.payments;
begin
  if new.status <> 'succeeded' or (tg_op = 'UPDATE' and old.status = 'succeeded') then
    return null;
  end if;
  select * into payment from public.payments p where p.id = new.payment_id for update;
  select coalesce(sum(r.amount_minor), 0) into total
    from public.refunds r where r.payment_id = new.payment_id and r.status = 'succeeded';

  update public.payments p
     set refunded_amount_minor = total,
         status = case when total >= p.amount_minor then 'refunded' else 'partially_refunded' end
   where p.id = new.payment_id;

  perform public.enqueue_outbox_event(
    'payment', new.payment_id::text, 'payment.refunded',
    jsonb_build_object('payment_id', new.payment_id, 'refund_id', new.id, 'amount_minor', new.amount_minor)
  );
  return null;
end;
$$;

create trigger refunds_apply after insert or update of status on public.refunds
  for each row execute function app_private.tg_refunds_apply();

-- ---------------------------------------------------------------------------------------------------
-- Disputes
-- ---------------------------------------------------------------------------------------------------
create table public.payment_disputes (
  id uuid primary key default gen_random_uuid(),
  currency_code char(3) not null,
  payment_id uuid not null,
  payment_provider_id uuid references public.payment_providers (id) on delete restrict,
  provider_reference text,
  kind text not null default 'chargeback',
  status text not null default 'opened',
  amount_minor bigint not null,
  funds_frozen boolean not null default true,
  reason_code text,
  opened_at timestamptz not null default now(),
  evidence_due_at timestamptz,
  evidence_submitted_at timestamptz,
  resolved_at timestamptz,
  outcome text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (payment_id, currency_code) references public.payments (id, currency_code) on delete restrict,
  constraint payment_disputes_kind_allowed check (kind in ('chargeback', 'inquiry', 'retrieval')),
  constraint payment_disputes_status_allowed check (status in ('opened', 'under_review', 'evidence_submitted', 'won', 'lost', 'closed')),
  constraint payment_disputes_amount_positive check (amount_minor > 0),
  constraint payment_disputes_outcome_allowed check (outcome is null or outcome in ('won', 'lost', 'withdrawn')),
  constraint payment_disputes_resolved_has_outcome check ((status in ('won', 'lost', 'closed')) = (resolved_at is not null)),
  constraint payment_disputes_resolved_frees_funds check (resolved_at is null or funds_frozen = false or status = 'lost'),
  unique (payment_provider_id, provider_reference)
);
comment on table public.payment_disputes is
  'A dispute freezes the order-linked amounts while it is open (D26). The handling policy itself is still blocked on D26; the record and its freeze flag are not.';
create index payment_disputes_payment on public.payment_disputes (payment_id, opened_at desc);
create index payment_disputes_open on public.payment_disputes (status, evidence_due_at) where resolved_at is null;
create trigger payment_disputes_set_updated_at before update on public.payment_disputes
  for each row execute function app_private.tg_set_updated_at();
create trigger payment_disputes_audit after insert or update on public.payment_disputes
  for each row execute function audit.tg_record_change();

create or replace function public.payment_has_open_dispute(p_payment_id uuid) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.payment_disputes d
    where d.payment_id = p_payment_id and d.resolved_at is null and d.funds_frozen
  );
$$;
comment on function public.payment_has_open_dispute(uuid) is
  'True while a dispute is holding this payment''s funds. 0021 uses it to block withdrawal of disputed funds (D26).';

-- ---------------------------------------------------------------------------------------------------
-- Currency dependencies (D16)
-- ---------------------------------------------------------------------------------------------------
select app_private.register_currency_dependency(
  'payments.currency_code', 'public', 'payments', 'currency_code',
  'payments in the currency that are not finished',
  $$status not in ('cancelled', 'expired', 'failed')$$
);
select app_private.register_currency_dependency(
  'payment_provider_capabilities.currency_code', 'public', 'payment_provider_capabilities', 'currency_code',
  'provider capabilities recorded for the currency'
);
select app_private.register_currency_dependency(
  'refunds.currency_code', 'public', 'refunds', 'currency_code',
  'refunds in the currency that are not finished',
  $$status not in ('cancelled', 'failed')$$
);

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table public.payment_providers enable row level security;
alter table public.payment_provider_capabilities enable row level security;
alter table public.payments enable row level security;
alter table public.payment_attempts enable row level security;
alter table public.payment_provider_transactions enable row level security;
alter table public.payment_events enable row level security;
alter table public.refunds enable row level security;
alter table public.refund_items enable row level security;
alter table public.payment_disputes enable row level security;

-- A buyer needs to know which gateways are available and what happened to their own money.
create policy payment_providers_public_read on public.payment_providers for select to authenticated
  using (is_enabled);
create policy payment_providers_admin_write on public.payment_providers for all to authenticated
  using (public.has_permission('payments.provider.manage') and public.is_aal2())
  with check (public.has_permission('payments.provider.manage') and public.is_aal2());

create policy payment_provider_capabilities_read on public.payment_provider_capabilities for select to authenticated
  using (exists (select 1 from public.payment_providers p where p.id = payment_provider_id and p.is_enabled));
create policy payment_provider_capabilities_admin_write on public.payment_provider_capabilities for all to authenticated
  using (public.has_permission('payments.provider.manage') and public.is_aal2())
  with check (public.has_permission('payments.provider.manage') and public.is_aal2());

create policy payments_buyer_read on public.payments for select to authenticated
  using (buyer_user_id = public.current_user_id());
create policy payments_staff_read on public.payments for select to authenticated
  using (public.has_permission('payments.payment.read'));

create policy payment_attempts_buyer_read on public.payment_attempts for select to authenticated
  using (exists (select 1 from public.payments p where p.id = payment_id and p.buyer_user_id = public.current_user_id()));
create policy payment_attempts_staff_read on public.payment_attempts for select to authenticated
  using (public.has_permission('payments.payment.read'));

-- Provider transactions and webhook receipts are server-only: no policy, no grant.

create policy refunds_buyer_read on public.refunds for select to authenticated
  using (exists (select 1 from public.payments p where p.id = payment_id and p.buyer_user_id = public.current_user_id()));
create policy refunds_seller_read on public.refunds for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and o.seller_user_id = public.current_user_id()));
create policy refunds_staff_read on public.refunds for select to authenticated
  using (public.has_permission('payments.refund.read'));
create policy refunds_staff_write on public.refunds for all to authenticated
  using (public.has_permission('payments.refund.manage') and public.is_aal2())
  with check (public.has_permission('payments.refund.manage') and public.is_aal2());

create policy refund_items_read on public.refund_items for select to authenticated
  using (exists (
    select 1 from public.refunds r join public.payments p on p.id = r.payment_id
    where r.id = refund_id and (p.buyer_user_id = public.current_user_id() or public.has_permission('payments.refund.read'))
  ));

create policy payment_disputes_staff_read on public.payment_disputes for select to authenticated
  using (public.has_permission('payments.dispute.read'));
create policy payment_disputes_staff_write on public.payment_disputes for all to authenticated
  using (public.has_permission('payments.dispute.manage') and public.is_aal2())
  with check (public.has_permission('payments.dispute.manage') and public.is_aal2());

grant select, insert, update, delete on public.payment_providers to authenticated;
grant select, insert, update, delete on public.payment_provider_capabilities to authenticated;
grant select on public.payments to authenticated;
grant select on public.payment_attempts to authenticated;
grant select, insert, update on public.refunds to authenticated;
grant select on public.refund_items to authenticated;
grant select, insert, update on public.payment_disputes to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function
  public.payment_provider_supports(uuid, char, text),
  public.payment_has_open_dispute(uuid)
  to authenticated;

grant execute on function
  public.payment_provider_supports(uuid, char, text),
  public.payment_has_open_dispute(uuid),
  app_private.record_payment_event(uuid, text, text, bytea, uuid, uuid),
  app_private.complete_payment_event(uuid, text)
  to app_system, app_worker;
