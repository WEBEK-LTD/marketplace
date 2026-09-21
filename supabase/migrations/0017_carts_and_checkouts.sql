-- 0017 — Carts, checkouts, checkout charges and tax lines, inventory reservations (v5.2 migration plan).
--
-- One cart holds items from several sellers; checkout turns it into ONE checkout and ONE payment, and
-- 0018 splits that into one order per seller. A guest cart is keyed by a random token whose hash alone is
-- stored, expires after a configurable window (30 days by default, D22) and merges into the account cart
-- after login.
--
-- The checkout steps this schema has to support, in order:
--   1. re-check price, stock, status and eligibility — only approved/active listings are purchasable;
--   2. apply coupons, recording the funding source (coupons arrive in 0024);
--   3. price shipping per seller from that seller's shipping profile;
--   4. add tax lines from the configurable tax rules;
--   5. add buyer-side charges only if the fee policy requires it (D20, still blocked);
--   6. snapshot the commission rule, fee policy, cancellation policy and commission-refund policy;
--   7. reserve stock for 15 minutes;
--   8. create the payment and its attempt (0019).
--
-- Every snapshot is stored on the checkout, so a later edit to a rule can never change a checkout that
-- has already been priced. Money is integer minor units throughout, with composite `(id, currency_code)`
-- keys so no child can disagree with its parent's currency.
--
-- `checkouts.reference` (D12, `CO-26-000001`) is filled by the sequence trigger added in 0018, together
-- with the seller order numbers, so both live in one place.

-- ---------------------------------------------------------------------------------------------------
-- Carts
-- ---------------------------------------------------------------------------------------------------
create table public.carts (
  id uuid primary key default gen_random_uuid(),
  currency_code char(3) not null references public.currencies (code) on delete restrict,
  user_id uuid references auth.users (id) on delete cascade,
  guest_token_hash bytea,
  status text not null default 'active',
  expires_at timestamptz not null,
  merged_into_cart_id uuid references public.carts (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint carts_owner_is_exclusive check ((user_id is null) <> (guest_token_hash is null)),
  constraint carts_status_allowed check (status in ('active', 'merged', 'converted', 'expired', 'abandoned')),
  constraint carts_merged_has_target check ((status = 'merged') = (merged_into_cart_id is not null)),
  constraint carts_not_merged_into_itself check (merged_into_cart_id is null or merged_into_cart_id <> id),
  unique (id, currency_code)
);
comment on table public.carts is
  'A cart holds items from several sellers. A guest cart stores only the hash of its cookie token and expires after the configured window (D22).';
create unique index carts_one_active_per_user on public.carts (user_id) where user_id is not null and status = 'active';
create unique index carts_one_active_per_guest on public.carts (guest_token_hash) where guest_token_hash is not null and status = 'active';
create index carts_expiring on public.carts (expires_at) where status = 'active';
create trigger carts_set_updated_at before update on public.carts
  for each row execute function app_private.tg_set_updated_at();

-- The expiry window is an admin setting, applied when the caller does not give one.
create or replace function app_private.tg_carts_expiry() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  days integer;
begin
  if new.expires_at is null then
    days := coalesce((public.site_setting('carts.guest_expiry_days'))::integer, 30);
    new.expires_at := now() + make_interval(days => days);
  end if;
  return new;
end;
$$;

alter table public.carts alter column expires_at drop not null;
create trigger carts_expiry before insert on public.carts
  for each row execute function app_private.tg_carts_expiry();
alter table public.carts add constraint carts_expiry_present check (expires_at is not null) not valid;
alter table public.carts validate constraint carts_expiry_present;

create table public.cart_items (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null,
  currency_code char(3) not null,
  listing_id uuid not null,
  seller_user_id uuid not null references public.seller_profiles (user_id) on delete cascade,
  quantity integer not null default 1,
  unit_price_minor bigint not null,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (cart_id, currency_code) references public.carts (id, currency_code) on delete cascade,
  foreign key (listing_id, currency_code) references public.listings (id, currency_code) on delete cascade,
  constraint cart_items_quantity_positive check (quantity >= 1),
  constraint cart_items_price_positive check (unit_price_minor >= 0),
  unique (cart_id, listing_id)
);
comment on table public.cart_items is
  '`unit_price_minor` is the price when the item was added; checkout re-checks it and shows any change (guest-cart merge rule).';
create index cart_items_by_seller on public.cart_items (cart_id, seller_user_id);
create trigger cart_items_set_updated_at before update on public.cart_items
  for each row execute function app_private.tg_set_updated_at();

-- Only a purchasable listing may sit in a cart, and its seller must be the one recorded.
create or replace function app_private.tg_cart_items_rule() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  listing_seller uuid;
  listing_state text;
begin
  select l.seller_user_id, l.status into listing_seller, listing_state
    from public.listings l where l.id = new.listing_id;
  if not public.listing_status_is_purchasable(listing_state) then
    raise exception 'only an approved or active listing can be added to a cart' using errcode = 'restrict_violation';
  end if;
  if new.seller_user_id is distinct from listing_seller then
    raise exception 'the cart item must record the listing''s own seller' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger cart_items_rule before insert or update on public.cart_items
  for each row execute function app_private.tg_cart_items_rule();

-- ---------------------------------------------------------------------------------------------------
-- Checkouts
-- ---------------------------------------------------------------------------------------------------
create table public.checkouts (
  id uuid primary key default gen_random_uuid(),
  reference text not null,
  currency_code char(3) not null references public.currencies (code) on delete restrict,
  buyer_user_id uuid not null references auth.users (id) on delete restrict,
  cart_id uuid references public.carts (id) on delete set null,
  status text not null default 'open',
  subtotal_minor bigint not null default 0,
  shipping_total_minor bigint not null default 0,
  tax_total_minor bigint not null default 0,
  discount_total_minor bigint not null default 0,
  buyer_fee_total_minor bigint not null default 0,
  grand_total_minor bigint not null default 0,
  shipping_address_snapshot jsonb,
  billing_address_snapshot jsonb,
  commission_snapshot jsonb,
  fee_policy_snapshot jsonb,
  cancellation_policy_snapshot jsonb,
  commission_refund_policy_snapshot jsonb,
  fulfilled_attempt_id uuid,
  reserved_until timestamptz,
  expires_at timestamptz,
  fulfilled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint checkouts_reference_format check (reference ~ '^CO-[0-9]{2}-[0-9]{6,}$'),
  constraint checkouts_status_allowed check (status in ('open', 'awaiting_payment', 'paid', 'fulfilled', 'expired', 'cancelled', 'failed')),
  constraint checkouts_amounts_positive check (
    subtotal_minor >= 0 and shipping_total_minor >= 0 and tax_total_minor >= 0
    and discount_total_minor >= 0 and buyer_fee_total_minor >= 0 and grand_total_minor >= 0
  ),
  constraint checkouts_total_adds_up check (
    grand_total_minor = subtotal_minor + shipping_total_minor + tax_total_minor + buyer_fee_total_minor - discount_total_minor
  ),
  constraint checkouts_discount_within_subtotal check (discount_total_minor <= subtotal_minor),
  constraint checkouts_snapshots_are_objects check (
    (shipping_address_snapshot is null or jsonb_typeof(shipping_address_snapshot) = 'object')
    and (billing_address_snapshot is null or jsonb_typeof(billing_address_snapshot) = 'object')
    and (commission_snapshot is null or jsonb_typeof(commission_snapshot) = 'object')
    and (fee_policy_snapshot is null or jsonb_typeof(fee_policy_snapshot) = 'object')
    and (cancellation_policy_snapshot is null or jsonb_typeof(cancellation_policy_snapshot) = 'object')
    and (commission_refund_policy_snapshot is null or jsonb_typeof(commission_refund_policy_snapshot) = 'object')
  ),
  -- A checkout may only reach payment once its pricing basis is snapshotted.
  constraint checkouts_awaiting_payment_is_snapshotted check (
    status = 'open' or (commission_snapshot is not null and cancellation_policy_snapshot is not null)
  ),
  constraint checkouts_fulfilled_has_attempt check ((status = 'fulfilled') = (fulfilled_attempt_id is not null)),
  constraint checkouts_fulfilled_has_time check ((status = 'fulfilled') = (fulfilled_at is not null)),
  unique (id, currency_code)
);
comment on table public.checkouts is
  'One checkout and one payment per cart. `fulfilled_attempt_id` is set exactly once, under a row lock, so only one attempt can ever fulfil it.';
comment on column public.checkouts.fulfilled_attempt_id is
  'The payment attempt that fulfilled this checkout. Migration 0019 adds the foreign key to payment_attempts.';
create unique index checkouts_reference on public.checkouts (reference);
create index checkouts_buyer on public.checkouts (buyer_user_id, created_at desc);
create index checkouts_open on public.checkouts (expires_at) where status in ('open', 'awaiting_payment');
create trigger checkouts_set_updated_at before update on public.checkouts
  for each row execute function app_private.tg_set_updated_at();

-- Once a checkout has been fulfilled, that decision is final.
create or replace function app_private.tg_checkouts_fulfilment_is_final() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.fulfilled_attempt_id is not null and new.fulfilled_attempt_id is distinct from old.fulfilled_attempt_id then
    raise exception 'checkout % has already been fulfilled by another attempt', old.id
      using errcode = 'restrict_violation';
  end if;
  if old.reference is not null and new.reference <> old.reference then
    raise exception 'the checkout reference is immutable' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger checkouts_fulfilment_is_final before update on public.checkouts
  for each row execute function app_private.tg_checkouts_fulfilment_is_final();

create table public.checkout_items (
  id uuid primary key default gen_random_uuid(),
  checkout_id uuid not null,
  currency_code char(3) not null,
  listing_id uuid not null references public.listings (id) on delete restrict,
  seller_user_id uuid not null references public.seller_profiles (user_id) on delete restrict,
  listing_type_code text not null references public.listing_types (code) on delete restrict,
  listing_title_snapshot text not null,
  listing_slug_snapshot text not null,
  quantity integer not null,
  unit_price_minor bigint not null,
  line_subtotal_minor bigint not null,
  discount_minor bigint not null default 0,
  tax_minor bigint not null default 0,
  line_total_minor bigint not null,
  cancellation_policy_snapshot jsonb,
  created_at timestamptz not null default now(),
  foreign key (checkout_id, currency_code) references public.checkouts (id, currency_code) on delete cascade,
  constraint checkout_items_quantity_positive check (quantity >= 1),
  constraint checkout_items_amounts_positive check (
    unit_price_minor >= 0 and line_subtotal_minor >= 0 and discount_minor >= 0 and tax_minor >= 0 and line_total_minor >= 0
  ),
  constraint checkout_items_subtotal_matches check (line_subtotal_minor = unit_price_minor * quantity),
  constraint checkout_items_total_adds_up check (line_total_minor = line_subtotal_minor - discount_minor + tax_minor),
  constraint checkout_items_discount_within_subtotal check (discount_minor <= line_subtotal_minor),
  unique (checkout_id, listing_id)
);
comment on table public.checkout_items is
  'The priced lines of a checkout, with the listing title and slug snapshotted so the record still reads correctly if the listing changes.';
create index checkout_items_by_seller on public.checkout_items (checkout_id, seller_user_id);

create table public.checkout_charges (
  id uuid primary key default gen_random_uuid(),
  checkout_id uuid not null,
  currency_code char(3) not null,
  charge_type text not null,
  seller_user_id uuid references public.seller_profiles (user_id) on delete restrict,
  label text not null,
  amount_minor bigint not null,
  shipping_rate_id uuid references public.shipping_rates (id) on delete set null,
  source_type text,
  source_id uuid,
  funding_source text,
  created_at timestamptz not null default now(),
  foreign key (checkout_id, currency_code) references public.checkouts (id, currency_code) on delete cascade,
  constraint checkout_charges_type_allowed check (charge_type in ('shipping', 'buyer_fee', 'discount', 'adjustment')),
  constraint checkout_charges_label_length check (length(btrim(label)) between 1 and 120),
  -- A discount is negative, everything else positive; the sign is part of the record, never inferred.
  constraint checkout_charges_sign_matches_type check (
    case when charge_type = 'discount' then amount_minor <= 0 else amount_minor >= 0 end
  ),
  constraint checkout_charges_shipping_is_per_seller check (charge_type <> 'shipping' or seller_user_id is not null),
  constraint checkout_charges_funding_source_allowed check (funding_source is null or funding_source in ('platform', 'seller')),
  constraint checkout_charges_discount_has_funding check (charge_type <> 'discount' or funding_source is not null),
  constraint checkout_charges_source_is_complete check ((source_type is null) = (source_id is null))
);
comment on table public.checkout_charges is
  'Shipping (per seller), buyer-side fees, discounts and adjustments. A discount always records whether the platform or the seller funded it (D11).';
create index checkout_charges_checkout on public.checkout_charges (checkout_id, charge_type);

create table public.checkout_tax_lines (
  id uuid primary key default gen_random_uuid(),
  checkout_id uuid not null,
  currency_code char(3) not null,
  checkout_item_id uuid references public.checkout_items (id) on delete cascade,
  tax_rule_id uuid references public.tax_rules (id) on delete restrict,
  name text not null,
  rate_basis_points integer not null,
  taxable_amount_minor bigint not null,
  tax_amount_minor bigint not null,
  is_price_inclusive boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (checkout_id, currency_code) references public.checkouts (id, currency_code) on delete cascade,
  constraint checkout_tax_lines_rate_range check (rate_basis_points between 0 and 10000),
  constraint checkout_tax_lines_amounts_positive check (taxable_amount_minor >= 0 and tax_amount_minor >= 0),
  constraint checkout_tax_lines_name_length check (length(btrim(name)) between 1 and 120)
);
comment on table public.checkout_tax_lines is 'Tax as it was computed, with the rate snapshotted. Later edits to a tax rule never change a priced checkout.';
create index checkout_tax_lines_checkout on public.checkout_tax_lines (checkout_id);

-- ---------------------------------------------------------------------------------------------------
-- Inventory reservations
-- ---------------------------------------------------------------------------------------------------
create table public.inventory_reservations (
  id uuid primary key default gen_random_uuid(),
  checkout_id uuid not null references public.checkouts (id) on delete cascade,
  listing_id uuid not null references public.listings (id) on delete cascade,
  quantity integer not null,
  expires_at timestamptz not null,
  released_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint inventory_reservations_quantity_positive check (quantity >= 1),
  constraint inventory_reservations_not_both_outcomes check (released_at is null or consumed_at is null),
  unique (checkout_id, listing_id)
);
comment on table public.inventory_reservations is
  'A 15-minute hold on stock while a checkout is paid for. A reservation is either consumed by fulfilment or released; it is never both.';
create index inventory_reservations_active on public.inventory_reservations (listing_id)
  where released_at is null and consumed_at is null;
create index inventory_reservations_expiring on public.inventory_reservations (expires_at)
  where released_at is null and consumed_at is null;

create or replace function public.reserved_quantity(p_listing_id uuid) returns integer
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(sum(r.quantity), 0)::integer
    from public.inventory_reservations r
   where r.listing_id = p_listing_id
     and r.released_at is null
     and r.consumed_at is null
     and r.expires_at > now();
$$;
comment on function public.reserved_quantity(uuid) is 'Stock currently held by live reservations. Expired holds no longer count.';

create or replace function public.available_quantity(p_listing_id uuid) returns integer
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select greatest(coalesce(d.quantity, 0) - public.reserved_quantity(p_listing_id), 0)
    from public.listing_product_details d
   where d.listing_id = p_listing_id;
$$;
comment on function public.available_quantity(uuid) is 'Stock a new checkout may still reserve: on-hand quantity minus live reservations.';

create or replace function app_private.reserve_checkout_stock(
  p_checkout_id uuid,
  p_hold interval default interval '15 minutes'
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  item record;
  reserved integer := 0;
  on_hand integer;
  held integer;
begin
  -- Serialise against concurrent checkouts of the same listing.
  for item in
    select ci.listing_id, ci.quantity
      from public.checkout_items ci
      join public.listings l on l.id = ci.listing_id
     where ci.checkout_id = p_checkout_id
       and l.listing_type_code <> 'service'
     order by ci.listing_id
  loop
    select d.quantity into on_hand
      from public.listing_product_details d
     where d.listing_id = item.listing_id
     for update;

    if on_hand is null then
      continue; -- nothing to reserve for a listing without stock tracking
    end if;

    select coalesce(sum(r.quantity), 0) into held
      from public.inventory_reservations r
     where r.listing_id = item.listing_id
       and r.released_at is null and r.consumed_at is null and r.expires_at > now()
       and r.checkout_id <> p_checkout_id;

    if on_hand - held < item.quantity then
      raise exception 'not enough stock for listing %: % available, % requested',
        item.listing_id, on_hand - held, item.quantity
        using errcode = 'restrict_violation';
    end if;

    insert into public.inventory_reservations (checkout_id, listing_id, quantity, expires_at)
    values (p_checkout_id, item.listing_id, item.quantity, now() + p_hold)
    on conflict (checkout_id, listing_id)
      do update set quantity = excluded.quantity, expires_at = excluded.expires_at, released_at = null;
    reserved := reserved + 1;
  end loop;

  update public.checkouts set reserved_until = now() + p_hold where id = p_checkout_id;
  return reserved;
end;
$$;
comment on function app_private.reserve_checkout_stock(uuid, interval) is
  'Holds stock for every stocked line of a checkout, or raises if any line cannot be covered. Rows are locked in listing order, so concurrent checkouts cannot deadlock.';

create or replace function app_private.release_expired_reservations(p_limit integer default 500) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  released integer;
begin
  with stale as (
    select r.id from public.inventory_reservations r
     where r.released_at is null and r.consumed_at is null and r.expires_at <= now()
     order by r.expires_at
     limit p_limit
     for update skip locked
  )
  update public.inventory_reservations r
     set released_at = now()
    from stale
   where r.id = stale.id;
  get diagnostics released = row_count;
  return released;
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- Currency dependencies (D16)
-- ---------------------------------------------------------------------------------------------------
select app_private.register_currency_dependency(
  'carts.currency_code', 'public', 'carts', 'currency_code',
  'open carts in the currency',
  $$status = 'active'$$
);
select app_private.register_currency_dependency(
  'checkouts.currency_code', 'public', 'checkouts', 'currency_code',
  'active checkouts in the currency',
  $$status in ('open', 'awaiting_payment', 'paid')$$
);

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table public.carts enable row level security;
alter table public.cart_items enable row level security;
alter table public.checkouts enable row level security;
alter table public.checkout_items enable row level security;
alter table public.checkout_charges enable row level security;
alter table public.checkout_tax_lines enable row level security;
alter table public.inventory_reservations enable row level security;

-- A guest cart has no owner in the database: it is reached only through the BFF, which holds the token.
create policy carts_self_all on public.carts for all to authenticated
  using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id());

create policy cart_items_self_all on public.cart_items for all to authenticated
  using (exists (select 1 from public.carts c where c.id = cart_id and c.user_id = public.current_user_id()))
  with check (exists (select 1 from public.carts c where c.id = cart_id and c.user_id = public.current_user_id()));

create policy checkouts_buyer_read on public.checkouts for select to authenticated
  using (buyer_user_id = public.current_user_id());
create policy checkouts_staff_read on public.checkouts for select to authenticated
  using (public.has_permission('orders.checkout.read'));
create policy checkouts_buyer_insert on public.checkouts for insert to authenticated
  with check (buyer_user_id = public.current_user_id());
create policy checkouts_buyer_update on public.checkouts for update to authenticated
  using (buyer_user_id = public.current_user_id() and status in ('open', 'awaiting_payment'))
  with check (buyer_user_id = public.current_user_id());

create policy checkout_items_buyer_read on public.checkout_items for select to authenticated
  using (exists (select 1 from public.checkouts c where c.id = checkout_id and c.buyer_user_id = public.current_user_id()));
create policy checkout_items_seller_read on public.checkout_items for select to authenticated
  using (seller_user_id = public.current_user_id());
create policy checkout_items_staff_read on public.checkout_items for select to authenticated
  using (public.has_permission('orders.checkout.read'));

create policy checkout_charges_buyer_read on public.checkout_charges for select to authenticated
  using (exists (select 1 from public.checkouts c where c.id = checkout_id and c.buyer_user_id = public.current_user_id()));
create policy checkout_charges_staff_read on public.checkout_charges for select to authenticated
  using (public.has_permission('orders.checkout.read'));

create policy checkout_tax_lines_buyer_read on public.checkout_tax_lines for select to authenticated
  using (exists (select 1 from public.checkouts c where c.id = checkout_id and c.buyer_user_id = public.current_user_id()));
create policy checkout_tax_lines_staff_read on public.checkout_tax_lines for select to authenticated
  using (public.has_permission('orders.checkout.read'));

create policy inventory_reservations_buyer_read on public.inventory_reservations for select to authenticated
  using (exists (select 1 from public.checkouts c where c.id = checkout_id and c.buyer_user_id = public.current_user_id()));

grant select, insert, update, delete on public.carts to authenticated;
grant select, insert, update, delete on public.cart_items to authenticated;
grant select, insert, update on public.checkouts to authenticated;
grant select on public.checkout_items to authenticated;
grant select on public.checkout_charges to authenticated;
grant select on public.checkout_tax_lines to authenticated;
grant select on public.inventory_reservations to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function
  public.reserved_quantity(uuid),
  public.available_quantity(uuid)
  to authenticated;

grant execute on function
  public.reserved_quantity(uuid),
  public.available_quantity(uuid),
  app_private.reserve_checkout_stock(uuid, interval),
  app_private.release_expired_reservations(integer)
  to app_system, app_worker;
