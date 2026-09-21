-- 0025 — Promotions: admin-defined packages with per-currency prices, placements and category
-- eligibility; the seller's promotion and its lifecycle; the wallet purchase; the refund policy; the
-- partitioned event stream and its rollups (v5.2 "Promotions"; D16, C10, C13, UB8).
--
-- Packages are admin-defined. Prices are per currency, so a package with no price in the seller's
-- currency simply cannot be bought — never converted at a rate nobody approved (D16). Placements and
-- category eligibility are their own tables, and a package with no category rows is eligible everywhere.
--
-- `billing_model` is `fixed`. `pay_on_sale` is reserved by the specification and deliberately not
-- implemented, which is why the column admits both values but a second constraint pins it to `fixed`:
-- the reservation is visible in the schema and unusable at the same time. There is no pay-per-impression
-- or pay-per-click in V1.
--
-- The seller flow the specification describes is the state machine here:
--
--   draft --> pending_payment --> paid --> scheduled --> active --> expired
--                                                    \--> paused --> active
--   any live state --> cancelled | refunded
--
-- Only Approved or Active listings are eligible, the listing must belong to the seller promoting it,
-- and a listing may carry only one live promotion at a time — a partial unique index, not a convention.
--
-- Paying from the wallet goes through `app_private.spend_wallet_on_promotion()` from 0021, which moves
-- the price from `seller_available` to `promotion_revenue` under a row lock and only when available
-- funds cover it in full. The card path waits for B1-A: no payment provider is assumed here, and a
-- promotion whose payment method is `card` cannot reach `paid` in this migration at all.
--
-- Cancelling applies the admin-configured refund policy, which is also what a promoted listing becoming
-- unavailable triggers. A refund posts the mirror journal — `promotion_revenue` debited, the seller's
-- available balance credited — so the money story stays double-entry and nothing is rewritten.
--
-- `promotion_events` is the at-least-once analytics stream, monthly-partitioned and deduplicated by
-- event id exactly like `listing_events` in 0013, and `promotion_analytics` is the pg_cron rollup target
-- (0032 schedules it). Neither is ever the authority for anything: both are recomputable from source.
--
-- Ranking weights live in `promotion_ranking_settings` for the search function to read. The formula
-- itself is a Phase 9 decision, so this migration stores the weights and decides nothing.

-- ---------------------------------------------------------------------------------------------------
-- Packages
-- ---------------------------------------------------------------------------------------------------
create table public.promotion_packages (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  name_en text not null,
  name_ar text not null,
  description_en text,
  description_ar text,
  billing_model text not null default 'fixed',
  duration_days integer not null,
  priority integer not null default 0,
  max_active_per_seller integer,
  max_active_total integer,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint promotion_packages_key_format check (key ~ '^[a-z][a-z0-9_]*$'),
  constraint promotion_packages_names_present check (
    length(btrim(name_en)) between 1 and 120 and length(btrim(name_ar)) between 1 and 120
  ),
  constraint promotion_packages_billing_model_allowed check (billing_model in ('fixed', 'pay_on_sale')),
  -- `pay_on_sale` is reserved by the specification and not implemented in V1, so nothing may use it.
  constraint promotion_packages_billing_model_is_fixed check (billing_model = 'fixed'),
  constraint promotion_packages_duration_positive check (duration_days between 1 and 365),
  constraint promotion_packages_limits_positive check (
    (max_active_per_seller is null or max_active_per_seller >= 1)
    and (max_active_total is null or max_active_total >= 1)
  )
);
comment on table public.promotion_packages is
  'Admin-defined promotion packages. Prices and durations are owner values; nothing is seeded here. `pay_on_sale` is reserved and unusable in V1, and there is no pay-per-impression or pay-per-click.';
create unique index promotion_packages_key on public.promotion_packages (key);
create index promotion_packages_live on public.promotion_packages (sort_order, priority desc) where is_active;
create trigger promotion_packages_set_updated_at before update on public.promotion_packages
  for each row execute function app_private.tg_set_updated_at();
create trigger promotion_packages_audit after insert or update or delete on public.promotion_packages
  for each row execute function audit.tg_record_change();

create table public.promotion_package_prices (
  promotion_package_id uuid not null references public.promotion_packages (id) on delete cascade,
  currency_code char(3) not null references public.currencies (code) on delete restrict,
  price_minor bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (promotion_package_id, currency_code),
  constraint promotion_package_prices_price_positive check (price_minor > 0)
);
comment on table public.promotion_package_prices is
  'One price per currency, in minor units. A package with no row for a currency cannot be bought in it (D16).';
create trigger promotion_package_prices_set_updated_at before update on public.promotion_package_prices
  for each row execute function app_private.tg_set_updated_at();
create trigger promotion_package_prices_audit after insert or update or delete on public.promotion_package_prices
  for each row execute function audit.tg_record_change();

create table public.promotion_package_placements (
  promotion_package_id uuid not null references public.promotion_packages (id) on delete cascade,
  placement text not null,
  created_at timestamptz not null default now(),
  primary key (promotion_package_id, placement),
  constraint promotion_package_placements_allowed check (
    placement in ('search_results', 'category_page', 'homepage', 'related_listings')
  )
);
comment on table public.promotion_package_placements is
  'Where a package puts a listing. Sponsored results are always labelled as such wherever they appear.';

create table public.promotion_package_categories (
  promotion_package_id uuid not null references public.promotion_packages (id) on delete cascade,
  category_id uuid not null references public.categories (id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (promotion_package_id, category_id)
);
comment on table public.promotion_package_categories is
  'Category eligibility. A package with no rows here is eligible everywhere; with rows, a listing qualifies if its category sits in one of those branches (D8).';

create or replace function public.promotion_package_price(
  p_package_id uuid,
  p_currency_code char(3)
) returns bigint
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p.price_minor
    from public.promotion_package_prices p
   where p.promotion_package_id = p_package_id and p.currency_code = p_currency_code;
$$;
comment on function public.promotion_package_price(uuid, char) is
  'The price of a package in a currency, or NULL when it has none. NULL means the package is not for sale there.';

create or replace function public.promotion_package_allows_category(
  p_package_id uuid,
  p_category_id uuid
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    not exists (select 1 from public.promotion_package_categories c where c.promotion_package_id = p_package_id)
    or exists (
      select 1 from public.promotion_package_categories c
       where c.promotion_package_id = p_package_id
         and public.category_is_within(p_category_id, c.category_id)
    );
$$;
comment on function public.promotion_package_allows_category(uuid, uuid) is
  'Whether a package may promote a listing in this category. No configured categories means everywhere; otherwise the listing must sit in one of the configured branches.';

-- ---------------------------------------------------------------------------------------------------
-- Refund policies
-- ---------------------------------------------------------------------------------------------------
create table public.promotion_refund_policies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  applies_to text not null,
  refund_percentage_basis_points integer not null,
  is_prorated boolean not null default false,
  priority integer not null default 0,
  effective_from date not null default current_date,
  effective_to date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint promotion_refund_policies_name_length check (length(btrim(name)) between 1 and 120),
  constraint promotion_refund_policies_applies_to_allowed check (
    applies_to in ('listing_unavailable', 'seller_cancelled', 'admin_cancelled')
  ),
  constraint promotion_refund_policies_percentage_range check (refund_percentage_basis_points between 0 and 10000),
  constraint promotion_refund_policies_effective_order check (effective_to is null or effective_to > effective_from)
);
comment on table public.promotion_refund_policies is
  'What a cancelled promotion gives back, by reason. A promoted listing becoming unavailable resolves through the same table, so there is one configured answer rather than two.';
create index promotion_refund_policies_lookup on public.promotion_refund_policies (applies_to, priority desc)
  where is_active;
create trigger promotion_refund_policies_set_updated_at before update on public.promotion_refund_policies
  for each row execute function app_private.tg_set_updated_at();
create trigger promotion_refund_policies_audit after insert or update or delete on public.promotion_refund_policies
  for each row execute function audit.tg_record_change();

create or replace function public.resolve_promotion_refund_policy(
  p_applies_to text,
  p_on date default null
) returns public.promotion_refund_policies
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p.*
    from public.promotion_refund_policies p
   where p.is_active
     and p.applies_to = p_applies_to
     and p.effective_from <= coalesce(p_on, current_date)
     and (p.effective_to is null or p.effective_to > coalesce(p_on, current_date))
   order by p.priority desc, p.created_at desc
   limit 1;
$$;
comment on function public.resolve_promotion_refund_policy(text, date) is
  'The policy that applies to a cancellation reason today. Nothing configured means nothing is refunded, which is the fail-closed answer.';

-- ---------------------------------------------------------------------------------------------------
-- Ranking weights
-- ---------------------------------------------------------------------------------------------------
create table public.promotion_ranking_settings (
  key text primary key,
  weight_basis_points integer not null,
  description_en text not null,
  description_ar text not null,
  is_active boolean not null default true,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint promotion_ranking_settings_key_format check (key ~ '^[a-z][a-z0-9_]*$'),
  constraint promotion_ranking_settings_weight_range check (weight_basis_points between 0 and 100000),
  constraint promotion_ranking_settings_descriptions_present check (
    length(btrim(description_en)) > 0 and length(btrim(description_ar)) > 0
  )
);
comment on table public.promotion_ranking_settings is
  'Admin-configurable weights the search function reads. The ranking formula itself is a Phase 9 decision; this table stores weights and decides nothing.';
create trigger promotion_ranking_settings_set_updated_at before update on public.promotion_ranking_settings
  for each row execute function app_private.tg_set_updated_at();
create trigger promotion_ranking_settings_audit after insert or update or delete on public.promotion_ranking_settings
  for each row execute function audit.tg_record_change();

-- ---------------------------------------------------------------------------------------------------
-- Promotions
-- ---------------------------------------------------------------------------------------------------
create table public.promotions (
  id uuid primary key default gen_random_uuid(),
  currency_code char(3) not null references public.currencies (code) on delete restrict,
  seller_user_id uuid not null references public.seller_profiles (user_id) on delete restrict,
  listing_id uuid not null references public.listings (id) on delete restrict,
  promotion_package_id uuid not null references public.promotion_packages (id) on delete restrict,
  status text not null default 'draft',
  payment_method text,
  price_minor bigint not null,
  priority integer not null default 0,
  duration_days integer not null,
  package_snapshot jsonb not null default '{}'::jsonb,
  idempotency_key text,
  starts_at timestamptz,
  ends_at timestamptz,
  paid_at timestamptz,
  activated_at timestamptz,
  paused_at timestamptz,
  expired_at timestamptz,
  cancelled_at timestamptz,
  refunded_at timestamptz,
  refunded_amount_minor bigint not null default 0,
  cancellation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint promotions_status_allowed check (status in (
    'draft', 'pending_payment', 'paid', 'scheduled', 'active', 'paused', 'expired', 'cancelled', 'refunded'
  )),
  constraint promotions_payment_method_allowed check (payment_method is null or payment_method in ('wallet', 'card')),
  constraint promotions_price_positive check (price_minor > 0),
  constraint promotions_duration_positive check (duration_days between 1 and 365),
  constraint promotions_snapshot_is_object check (jsonb_typeof(package_snapshot) = 'object'),
  constraint promotions_paid_has_method check (paid_at is null or payment_method is not null),
  constraint promotions_paid_has_time check (
    status in ('draft', 'pending_payment', 'cancelled') or paid_at is not null
  ),
  constraint promotions_window_order check (ends_at is null or starts_at is null or ends_at > starts_at),
  constraint promotions_live_has_window check (status not in ('scheduled', 'active', 'paused') or (starts_at is not null and ends_at is not null)),
  -- One-way on purpose: a cancelled promotion may go on to be refunded, and the time it was
  -- cancelled stays on the record.
  constraint promotions_expired_has_time check (status <> 'expired' or expired_at is not null),
  constraint promotions_cancelled_has_time check (status <> 'cancelled' or cancelled_at is not null),
  constraint promotions_refunded_has_time check (status <> 'refunded' or refunded_at is not null),
  constraint promotions_refunded_amount_within_price check (refunded_amount_minor between 0 and price_minor),
  unique (id, currency_code)
);
comment on table public.promotions is
  'One seller promotion of one listing through one package. The price and the package are snapshotted at purchase, so later edits to a package never change a promotion that was already bought.';
comment on column public.promotions.payment_method is
  'How it was paid. `wallet` is implemented here; `card` waits for B1-A and cannot reach `paid` in this migration.';
-- A listing carries at most one live promotion: the boost is not stackable.
create unique index promotions_one_live_per_listing on public.promotions (listing_id)
  where status in ('paid', 'scheduled', 'active', 'paused');
create unique index promotions_idempotency on public.promotions (idempotency_key) where idempotency_key is not null;
create index promotions_seller on public.promotions (seller_user_id, status, created_at desc);
create index promotions_due_to_start on public.promotions (starts_at) where status = 'scheduled';
create index promotions_due_to_expire on public.promotions (ends_at) where status = 'active';
create index promotions_live_for_listing on public.promotions (listing_id, priority desc) where status = 'active';
create trigger promotions_set_updated_at before update on public.promotions
  for each row execute function app_private.tg_set_updated_at();
create trigger promotions_audit after insert or update or delete on public.promotions
  for each row execute function audit.tg_record_change('cancellation_reason');

create table public.promotion_status_history (
  id bigint generated always as identity primary key,
  promotion_id uuid not null references public.promotions (id) on delete cascade,
  from_status text,
  to_status text not null,
  reason text,
  changed_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
comment on table public.promotion_status_history is
  'Every state a promotion passed through, append-only. This is the record a seller and an admin both read back.';
create index promotion_status_history_promotion on public.promotion_status_history (promotion_id, created_at);
create trigger promotion_status_history_append_only before update or delete on public.promotion_status_history
  for each row execute function app_private.tg_reject_write();

-- The opening history row waits until the promotion exists, so it runs AFTER INSERT.
create or replace function app_private.tg_promotions_created() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.promotion_status_history (promotion_id, from_status, to_status)
  values (new.id, null, new.status);
  return null;
end;
$$;

create trigger promotions_created after insert on public.promotions
  for each row execute function app_private.tg_promotions_created();

create or replace function app_private.tg_promotions_transition() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.price_minor <> old.price_minor then
    raise exception 'the price of a promotion is immutable once bought' using errcode = 'restrict_violation';
  end if;
  if new.status = old.status then
    return new;
  end if;

  if not (
    -- Paying from the wallet is immediate, so a draft may reach `paid` in one move; the card flow
    -- goes through `pending_payment` while the provider is asked (B1-A).
    (old.status = 'draft' and new.status in ('pending_payment', 'paid', 'cancelled'))
    or (old.status = 'pending_payment' and new.status in ('paid', 'cancelled'))
    or (old.status = 'paid' and new.status in ('scheduled', 'cancelled', 'refunded'))
    or (old.status = 'scheduled' and new.status in ('active', 'paused', 'cancelled', 'refunded'))
    or (old.status = 'active' and new.status in ('paused', 'expired', 'cancelled', 'refunded'))
    or (old.status = 'paused' and new.status in ('active', 'expired', 'cancelled', 'refunded'))
    or (old.status = 'cancelled' and new.status = 'refunded')
  ) then
    raise exception 'a promotion cannot move from % to %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  -- A card-paid promotion cannot be settled until a payment provider exists (B1-A).
  if new.status = 'paid' and new.payment_method = 'card' then
    raise exception 'card payment for promotions is not available yet (B1-A)' using errcode = 'restrict_violation';
  end if;

  insert into public.promotion_status_history (promotion_id, from_status, to_status, reason)
  values (new.id, old.status, new.status, new.cancellation_reason);
  return new;
end;
$$;
comment on function app_private.tg_promotions_transition() is
  'The promotion state machine and its history in one place: an edge that is not on the approved flow is refused, and every edge that is taken is recorded.';

create trigger promotions_transition before update on public.promotions
  for each row execute function app_private.tg_promotions_transition();

create table public.promotion_transactions (
  id uuid primary key default gen_random_uuid(),
  promotion_id uuid not null,
  currency_code char(3) not null,
  kind text not null,
  payment_method text not null,
  amount_minor bigint not null,
  ledger_journal_id uuid references public.ledger_journals (id) on delete restrict,
  payment_id uuid references public.payments (id) on delete restrict,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  foreign key (promotion_id, currency_code) references public.promotions (id, currency_code) on delete restrict,
  constraint promotion_transactions_kind_allowed check (kind in ('purchase', 'refund')),
  constraint promotion_transactions_method_allowed check (payment_method in ('wallet', 'card')),
  constraint promotion_transactions_amount_positive check (amount_minor > 0),
  constraint promotion_transactions_idempotency_key_length check (length(idempotency_key) between 8 and 255),
  -- A wallet movement always names the journal that made it; a card movement names its payment.
  constraint promotion_transactions_wallet_has_journal check (
    payment_method <> 'wallet' or ledger_journal_id is not null
  )
);
comment on table public.promotion_transactions is
  'What was paid for a promotion and what was given back, append-only. A wallet movement always points at the ledger journal that made it.';
create unique index promotion_transactions_idempotency on public.promotion_transactions (idempotency_key);
create index promotion_transactions_promotion on public.promotion_transactions (promotion_id, created_at);
create trigger promotion_transactions_append_only before update or delete on public.promotion_transactions
  for each row execute function app_private.tg_reject_write();

-- ---------------------------------------------------------------------------------------------------
-- Eligibility
-- ---------------------------------------------------------------------------------------------------
create or replace function public.listing_is_promotable(
  p_listing_id uuid,
  p_seller_user_id uuid
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.listings l
     where l.id = p_listing_id
       and l.seller_user_id = p_seller_user_id
       -- Only Approved and Active listings are eligible; nothing sold, expired or archived is.
       and l.status in ('approved', 'active')
  );
$$;
comment on function public.listing_is_promotable(uuid, uuid) is
  'Whether this seller may promote this listing: it is theirs and it is Approved or Active. Everything else answers false.';

create or replace function public.active_promotion_for_listing(p_listing_id uuid)
returns public.promotions
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p.*
    from public.promotions p
   where p.listing_id = p_listing_id
     and p.status = 'active'
     and p.starts_at <= now()
     and p.ends_at > now()
   order by p.priority desc
   limit 1;
$$;
comment on function public.active_promotion_for_listing(uuid) is
  'The promotion currently boosting a listing, if any. Search reads this to know what to label as sponsored.';

-- ---------------------------------------------------------------------------------------------------
-- Buying a promotion
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.create_promotion(
  p_seller_user_id uuid,
  p_listing_id uuid,
  p_promotion_package_id uuid,
  p_currency_code char(3),
  p_idempotency_key text default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  package public.promotion_packages;
  listing_category uuid;
  price bigint;
  existing_id uuid;
  active_for_seller integer;
  active_total integer;
  new_promotion_id uuid;
begin
  if p_idempotency_key is not null then
    select p.id into existing_id from public.promotions p where p.idempotency_key = p_idempotency_key;
    if existing_id is not null then
      return existing_id; -- C10
    end if;
  end if;

  if not public.listing_is_promotable(p_listing_id, p_seller_user_id) then
    raise exception 'listing % is not eligible for promotion by this seller', p_listing_id
      using errcode = 'restrict_violation';
  end if;

  select * into package from public.promotion_packages p where p.id = p_promotion_package_id and p.is_active;
  if package.id is null then
    raise exception 'promotion package % is not available', p_promotion_package_id using errcode = 'restrict_violation';
  end if;

  select l.category_id into listing_category from public.listings l where l.id = p_listing_id;
  if not public.promotion_package_allows_category(p_promotion_package_id, listing_category) then
    raise exception 'package % does not cover this listing''s category', p_promotion_package_id
      using errcode = 'restrict_violation';
  end if;

  -- D16: a package with no price in this currency is not sold in it, and is never converted.
  price := public.promotion_package_price(p_promotion_package_id, p_currency_code);
  if price is null then
    raise exception 'package % has no price in %', p_promotion_package_id, p_currency_code
      using errcode = 'restrict_violation';
  end if;

  if package.max_active_per_seller is not null then
    select count(*) into active_for_seller
      from public.promotions p
     where p.promotion_package_id = p_promotion_package_id
       and p.seller_user_id = p_seller_user_id
       and p.status in ('paid', 'scheduled', 'active', 'paused');
    if active_for_seller >= package.max_active_per_seller then
      raise exception 'this seller already holds % of this package', active_for_seller
        using errcode = 'restrict_violation';
    end if;
  end if;

  if package.max_active_total is not null then
    select count(*) into active_total
      from public.promotions p
     where p.promotion_package_id = p_promotion_package_id
       and p.status in ('paid', 'scheduled', 'active', 'paused');
    if active_total >= package.max_active_total then
      raise exception 'this package is fully taken' using errcode = 'restrict_violation';
    end if;
  end if;

  insert into public.promotions (
    currency_code, seller_user_id, listing_id, promotion_package_id, price_minor, priority,
    duration_days, package_snapshot, idempotency_key
  )
  values (
    p_currency_code, p_seller_user_id, p_listing_id, p_promotion_package_id, price, package.priority,
    package.duration_days,
    jsonb_build_object(
      'key', package.key, 'name_en', package.name_en, 'name_ar', package.name_ar,
      'duration_days', package.duration_days, 'priority', package.priority,
      'billing_model', package.billing_model,
      'placements', coalesce((
        select jsonb_agg(pl.placement order by pl.placement)
          from public.promotion_package_placements pl
         where pl.promotion_package_id = p_promotion_package_id
      ), '[]'::jsonb)
    ),
    p_idempotency_key
  )
  returning id into new_promotion_id;

  return new_promotion_id;
end;
$$;
comment on function app_private.create_promotion(uuid, uuid, uuid, char, text) is
  'Creates a draft promotion after eligibility, category coverage, per-currency pricing and the package limits have all agreed. Nothing is paid here.';

create or replace function app_private.pay_promotion_from_wallet(
  p_promotion_id uuid,
  p_idempotency_key text
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  promotion public.promotions;
  journal_id uuid;
begin
  select * into promotion from public.promotions p where p.id = p_promotion_id for update;
  if promotion.id is null then
    raise exception 'promotion % does not exist', p_promotion_id using errcode = 'no_data_found';
  end if;

  -- C10: a retry finds the payment already made and changes nothing.
  if exists (select 1 from public.promotion_transactions t where t.idempotency_key = p_idempotency_key) then
    return 'already_paid';
  end if;
  if promotion.status not in ('draft', 'pending_payment') then
    raise exception 'promotion % is % and is not awaiting payment', p_promotion_id, promotion.status
      using errcode = 'restrict_violation';
  end if;

  -- The listing must still be eligible at the moment the money moves, not only when it was chosen.
  if not public.listing_is_promotable(promotion.listing_id, promotion.seller_user_id) then
    raise exception 'listing % is no longer eligible for promotion', promotion.listing_id
      using errcode = 'restrict_violation';
  end if;

  -- 0021 does the money: available funds only, in full, under a row lock.
  journal_id := app_private.spend_wallet_on_promotion(
    promotion.seller_user_id, promotion.currency_code, promotion.price_minor,
    'promotion', p_promotion_id::text, format('promotion:%s:purchase', p_promotion_id)
  );

  insert into public.promotion_transactions (
    promotion_id, currency_code, kind, payment_method, amount_minor, ledger_journal_id, idempotency_key
  )
  values (
    p_promotion_id, promotion.currency_code, 'purchase', 'wallet', promotion.price_minor,
    journal_id, p_idempotency_key
  );

  update public.promotions
     set status = 'paid', payment_method = 'wallet', paid_at = now()
   where id = p_promotion_id;

  update public.promotions
     set status = 'scheduled',
         starts_at = now(),
         ends_at = now() + make_interval(days => duration_days)
   where id = p_promotion_id;

  perform public.enqueue_outbox_event(
    'promotion', p_promotion_id::text, 'promotion.paid',
    jsonb_build_object('promotion_id', p_promotion_id, 'seller_user_id', promotion.seller_user_id,
                       'currency_code', promotion.currency_code, 'amount_minor', promotion.price_minor,
                       'payment_method', 'wallet')
  );
  return 'paid';
end;
$$;
comment on function app_private.pay_promotion_from_wallet(uuid, text) is
  'Buys a promotion from the seller''s available balance and schedules it, all in one transaction. The card path waits for B1-A.';

-- ---------------------------------------------------------------------------------------------------
-- Running and ending
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.start_due_promotions(p_limit integer default 500) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  started integer;
begin
  with due as (
    select p.id from public.promotions p
     where p.status = 'scheduled' and p.starts_at <= now() and p.ends_at > now()
     order by p.starts_at
     limit greatest(p_limit, 0)
  )
  update public.promotions p
     set status = 'active', activated_at = coalesce(p.activated_at, now())
    from due
   where p.id = due.id;
  get diagnostics started = row_count;

  -- C13: the search cache must forget a listing whose promotion state changed.
  if started > 0 then
    perform public.enqueue_outbox_event('promotion', 'batch', 'promotion.started',
      jsonb_build_object('count', started));
  end if;
  return started;
end;
$$;
comment on function app_private.start_due_promotions(integer) is
  'Moves scheduled promotions that have reached their start into active. Scheduled by pg_cron in 0032.';

create or replace function app_private.expire_due_promotions(p_limit integer default 500) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  expired integer;
begin
  with due as (
    select p.id from public.promotions p
     where p.status in ('active', 'paused') and p.ends_at <= now()
     order by p.ends_at
     limit greatest(p_limit, 0)
  )
  update public.promotions p
     set status = 'expired', expired_at = now()
    from due
   where p.id = due.id;
  get diagnostics expired = row_count;

  if expired > 0 then
    perform public.enqueue_outbox_event('promotion', 'batch', 'promotion.expired',
      jsonb_build_object('count', expired));
  end if;
  return expired;
end;
$$;
comment on function app_private.expire_due_promotions(integer) is
  'Ends promotions whose window has closed. Scheduled by pg_cron in 0032, alongside the expiry-warning job the worker sends.';

create or replace function app_private.cancel_promotion(
  p_promotion_id uuid,
  p_applies_to text,
  p_reason text,
  p_actor_user_id uuid default null
) returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  promotion public.promotions;
  refund_policy public.promotion_refund_policies;
  elapsed_days integer;
  refundable bigint := 0;
  journal_id uuid;
begin
  select * into promotion from public.promotions p where p.id = p_promotion_id for update;
  if promotion.id is null then
    raise exception 'promotion % does not exist', p_promotion_id using errcode = 'no_data_found';
  end if;
  if promotion.status in ('expired', 'cancelled', 'refunded') then
    raise exception 'promotion % is already %', p_promotion_id, promotion.status using errcode = 'restrict_violation';
  end if;

  refund_policy := public.resolve_promotion_refund_policy(p_applies_to);

  -- Nothing configured refunds nothing: the fail-closed answer, not a guessed one.
  if refund_policy.id is not null and promotion.paid_at is not null then
    refundable := (promotion.price_minor * refund_policy.refund_percentage_basis_points + 5000) / 10000;
    if refund_policy.is_prorated and promotion.starts_at is not null then
      elapsed_days := greatest(0, least(promotion.duration_days,
        floor(extract(epoch from (now() - promotion.starts_at)) / 86400)::integer));
      refundable := (refundable * (promotion.duration_days - elapsed_days) + promotion.duration_days / 2)
                    / promotion.duration_days;
    end if;
    refundable := least(refundable, promotion.price_minor - promotion.refunded_amount_minor);
  end if;

  update public.promotions
     set status = 'cancelled', cancelled_at = now(), cancellation_reason = p_reason
   where id = p_promotion_id;

  if refundable > 0 then
    -- The mirror of the purchase: what the platform earned goes back to the seller's wallet.
    journal_id := app_private.post_ledger_journal(
      'refund',
      promotion.currency_code,
      jsonb_build_array(
        jsonb_build_object('account_type', 'promotion_revenue', 'direction', 'debit',
                           'amount_minor', refundable, 'memo', 'promotion refunded'),
        jsonb_build_object('account_type', 'seller_available', 'seller_user_id', promotion.seller_user_id,
                           'direction', 'credit', 'amount_minor', refundable, 'memo', 'promotion refunded')
      ),
      'promotion', p_promotion_id::text,
      format('promotion:%s:refund', p_promotion_id), 'Promotion refunded', p_actor_user_id
    );

    insert into public.promotion_transactions (
      promotion_id, currency_code, kind, payment_method, amount_minor, ledger_journal_id, idempotency_key
    )
    values (
      p_promotion_id, promotion.currency_code, 'refund', coalesce(promotion.payment_method, 'wallet'),
      refundable, journal_id, format('promotion:%s:refund', p_promotion_id)
    );

    update public.promotions
       set status = 'refunded', refunded_at = now(), refunded_amount_minor = refunded_amount_minor + refundable
     where id = p_promotion_id;
  end if;

  perform public.enqueue_outbox_event(
    'promotion', p_promotion_id::text, 'promotion.cancelled',
    jsonb_build_object('promotion_id', p_promotion_id, 'applies_to', p_applies_to,
                       'refunded_amount_minor', refundable)
  );
  return refundable;
end;
$$;
comment on function app_private.cancel_promotion(uuid, text, text, uuid) is
  'Cancels a promotion and applies the configured refund policy, prorating when it says to. With no policy configured nothing is refunded, which is what a promoted listing going unavailable falls back to.';

-- ---------------------------------------------------------------------------------------------------
-- Events and rollups
-- ---------------------------------------------------------------------------------------------------
create table public.promotion_events (
  id bigint generated always as identity,
  event_id uuid not null,
  promotion_id uuid not null,
  listing_id uuid not null,
  seller_user_id uuid,
  event_type text not null,
  placement text,
  occurred_at timestamptz not null default now(),
  user_id uuid,
  session_hash bytea,
  primary key (id, occurred_at),
  constraint promotion_events_type_allowed check (event_type in ('impression', 'view', 'click')),
  constraint promotion_events_placement_allowed check (
    placement is null or placement in ('search_results', 'category_page', 'homepage', 'related_listings')
  )
) partition by range (occurred_at);
comment on table public.promotion_events is
  'At-least-once sponsored-placement stream, deduplicated by `event_id`, monthly-partitioned like listing_events. Identifiers and a hashed session only — never an IP address or a raw session id. V1 counts impressions, views and clicks for reporting; nothing here is ever billed on.';

create unique index promotion_events_event_id on public.promotion_events (event_id, occurred_at);
create index promotion_events_promotion on public.promotion_events (promotion_id, occurred_at desc);
create index promotion_events_seller on public.promotion_events (seller_user_id, occurred_at desc);
create trigger promotion_events_append_only before update or delete on public.promotion_events
  for each row execute function app_private.tg_reject_write();

select app_private.ensure_month_partitions('public', 'promotion_events', 3);

create or replace function app_private.record_promotion_events(p_events jsonb) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  inserted integer;
begin
  if jsonb_typeof(p_events) <> 'array' then
    raise exception 'record_promotion_events expects a JSON array of events';
  end if;
  insert into public.promotion_events (
    event_id, promotion_id, listing_id, seller_user_id, event_type, placement, occurred_at, user_id, session_hash
  )
  select
    (e ->> 'event_id')::uuid,
    (e ->> 'promotion_id')::uuid,
    (e ->> 'listing_id')::uuid,
    nullif(e ->> 'seller_user_id', '')::uuid,
    e ->> 'event_type',
    nullif(e ->> 'placement', ''),
    coalesce(nullif(e ->> 'occurred_at', '')::timestamptz, now()),
    nullif(e ->> 'user_id', '')::uuid,
    decode(coalesce(nullif(e ->> 'session_hash', ''), ''), 'hex')
  from jsonb_array_elements(p_events) as e
  on conflict (event_id, occurred_at) do nothing;
  get diagnostics inserted = row_count;
  return inserted;
end;
$$;
comment on function app_private.record_promotion_events(jsonb) is
  'Batched insert used by the analytics consumer and by the degraded direct path. Repeats are dropped by event id.';

create table public.promotion_analytics (
  promotion_id uuid not null references public.promotions (id) on delete cascade,
  day date not null,
  impressions bigint not null default 0,
  views bigint not null default 0,
  clicks bigint not null default 0,
  computed_at timestamptz not null default now(),
  primary key (promotion_id, day),
  constraint promotion_analytics_counts_not_negative check (
    impressions >= 0 and views >= 0 and clicks >= 0
  )
);
comment on table public.promotion_analytics is
  'Daily rollups of promotion_events, written only by the pg_cron job and read through the Promotions service. Recomputable from source, so it is never the authority for anything.';
create index promotion_analytics_by_day on public.promotion_analytics (day desc);

create or replace function app_private.rollup_promotion_analytics(p_day date default null) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target date := coalesce(p_day, (current_date - 1));
  rolled integer;
begin
  insert into public.promotion_analytics (promotion_id, day, impressions, views, clicks, computed_at)
  select
    e.promotion_id,
    target,
    count(*) filter (where e.event_type = 'impression'),
    count(*) filter (where e.event_type = 'view'),
    count(*) filter (where e.event_type = 'click'),
    now()
  from public.promotion_events e
  where e.occurred_at >= target and e.occurred_at < target + 1
  group by e.promotion_id
  on conflict (promotion_id, day) do update
    set impressions = excluded.impressions,
        views = excluded.views,
        clicks = excluded.clicks,
        computed_at = excluded.computed_at;
  get diagnostics rolled = row_count;
  return rolled;
end;
$$;
comment on function app_private.rollup_promotion_analytics(date) is
  'Recomputes one day of rollups from the event stream. Idempotent by construction: running it again for the same day overwrites with the same answer.';

-- ---------------------------------------------------------------------------------------------------
-- Currency dependencies (D16)
-- ---------------------------------------------------------------------------------------------------
select app_private.register_currency_dependency(
  'promotion_package_prices.currency_code', 'public', 'promotion_package_prices', 'currency_code',
  'promotion package prices configured for the currency'
);
select app_private.register_currency_dependency(
  'promotions.currency_code', 'public', 'promotions', 'currency_code',
  'promotions in the currency that are not finished',
  $$status in ('draft', 'pending_payment', 'paid', 'scheduled', 'active', 'paused')$$
);

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table public.promotion_packages enable row level security;
alter table public.promotion_package_prices enable row level security;
alter table public.promotion_package_placements enable row level security;
alter table public.promotion_package_categories enable row level security;
alter table public.promotion_refund_policies enable row level security;
alter table public.promotion_ranking_settings enable row level security;
alter table public.promotions enable row level security;
alter table public.promotion_status_history enable row level security;
alter table public.promotion_transactions enable row level security;
alter table public.promotion_events enable row level security;
alter table public.promotion_analytics enable row level security;

-- A seller has to see what is on sale before buying it.
create policy promotion_packages_public_read on public.promotion_packages for select to authenticated
  using (is_active or public.has_permission('marketing.promotion.manage'));
create policy promotion_packages_admin_write on public.promotion_packages for all to authenticated
  using (public.has_permission('marketing.promotion.manage') and public.is_aal2())
  with check (public.has_permission('marketing.promotion.manage') and public.is_aal2());

create policy promotion_package_prices_read on public.promotion_package_prices for select to authenticated
  using (exists (select 1 from public.promotion_packages p where p.id = promotion_package_id and p.is_active)
         or public.has_permission('marketing.promotion.manage'));
create policy promotion_package_prices_admin_write on public.promotion_package_prices for all to authenticated
  using (public.has_permission('marketing.promotion.manage') and public.is_aal2())
  with check (public.has_permission('marketing.promotion.manage') and public.is_aal2());

create policy promotion_package_placements_read on public.promotion_package_placements for select to authenticated
  using (exists (select 1 from public.promotion_packages p where p.id = promotion_package_id and p.is_active)
         or public.has_permission('marketing.promotion.manage'));
create policy promotion_package_placements_admin_write on public.promotion_package_placements for all to authenticated
  using (public.has_permission('marketing.promotion.manage') and public.is_aal2())
  with check (public.has_permission('marketing.promotion.manage') and public.is_aal2());

create policy promotion_package_categories_read on public.promotion_package_categories for select to authenticated
  using (exists (select 1 from public.promotion_packages p where p.id = promotion_package_id and p.is_active)
         or public.has_permission('marketing.promotion.manage'));
create policy promotion_package_categories_admin_write on public.promotion_package_categories for all to authenticated
  using (public.has_permission('marketing.promotion.manage') and public.is_aal2())
  with check (public.has_permission('marketing.promotion.manage') and public.is_aal2());

create policy promotion_refund_policies_read on public.promotion_refund_policies for select to authenticated
  using (is_active or public.has_permission('marketing.promotion.manage'));
create policy promotion_refund_policies_admin_write on public.promotion_refund_policies for all to authenticated
  using (public.has_permission('marketing.promotion.manage') and public.is_aal2())
  with check (public.has_permission('marketing.promotion.manage') and public.is_aal2());

create policy promotion_ranking_settings_read on public.promotion_ranking_settings for select to authenticated
  using (public.has_permission('marketing.promotion.read'));
create policy promotion_ranking_settings_admin_write on public.promotion_ranking_settings for all to authenticated
  using (public.has_permission('marketing.promotion.manage') and public.is_aal2())
  with check (public.has_permission('marketing.promotion.manage') and public.is_aal2());

create policy promotions_seller_read on public.promotions for select to authenticated
  using (seller_user_id = public.current_user_id());
create policy promotions_staff_read on public.promotions for select to authenticated
  using (public.has_permission('marketing.promotion.read'));

create policy promotion_status_history_read on public.promotion_status_history for select to authenticated
  using (exists (
    select 1 from public.promotions p
     where p.id = promotion_id
       and (p.seller_user_id = public.current_user_id() or public.has_permission('marketing.promotion.read'))
  ));

create policy promotion_transactions_read on public.promotion_transactions for select to authenticated
  using (exists (
    select 1 from public.promotions p
     where p.id = promotion_id
       and (p.seller_user_id = public.current_user_id() or public.has_permission('marketing.promotion.read'))
  ));

create policy promotion_events_seller_read on public.promotion_events for select to authenticated
  using (seller_user_id = public.current_user_id());
create policy promotion_events_admin_read on public.promotion_events for select to authenticated
  using (public.has_permission('analytics.listing.read'));

create policy promotion_analytics_read on public.promotion_analytics for select to authenticated
  using (exists (
    select 1 from public.promotions p
     where p.id = promotion_id
       and (p.seller_user_id = public.current_user_id() or public.has_permission('analytics.listing.read'))
  ));

grant select, insert, update, delete on public.promotion_packages to authenticated;
grant select, insert, update, delete on public.promotion_package_prices to authenticated;
grant select, insert, update, delete on public.promotion_package_placements to authenticated;
grant select, insert, update, delete on public.promotion_package_categories to authenticated;
grant select, insert, update, delete on public.promotion_refund_policies to authenticated;
grant select, insert, update, delete on public.promotion_ranking_settings to authenticated;
grant select on public.promotions to authenticated;
grant select on public.promotion_status_history to authenticated;
grant select on public.promotion_transactions to authenticated;
grant select on public.promotion_events to authenticated;
grant select on public.promotion_analytics to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function
  public.promotion_package_price(uuid, char),
  public.promotion_package_allows_category(uuid, uuid),
  public.resolve_promotion_refund_policy(text, date),
  public.listing_is_promotable(uuid, uuid),
  public.active_promotion_for_listing(uuid)
  to authenticated;

grant execute on function
  public.promotion_package_price(uuid, char),
  public.promotion_package_allows_category(uuid, uuid),
  public.resolve_promotion_refund_policy(text, date),
  public.listing_is_promotable(uuid, uuid),
  public.active_promotion_for_listing(uuid),
  app_private.create_promotion(uuid, uuid, uuid, char, text),
  app_private.pay_promotion_from_wallet(uuid, text),
  app_private.start_due_promotions(integer),
  app_private.expire_due_promotions(integer),
  app_private.cancel_promotion(uuid, text, text, uuid),
  app_private.record_promotion_events(jsonb),
  app_private.rollup_promotion_analytics(date)
  to app_system, app_worker;
