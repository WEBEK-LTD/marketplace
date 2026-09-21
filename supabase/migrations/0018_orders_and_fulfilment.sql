-- 0018 — Orders, order items, shipments, service deliveries, cancellations, and the order and checkout
-- reference sequences (v5.2 migration plan; D12, D23).
--
-- One checkout becomes one order per seller: `orders` carries a unique key on (checkout_id,
-- seller_user_id), and `fulfil_checkout()` is the single function that creates the seller orders, their
-- items and the stock decrements, consumes the reservations and writes the outbox events in one
-- transaction. It sets `checkouts.fulfilled_attempt_id` once under a row lock, so extra payment
-- successes can never create a second set of orders — they are detected idempotently instead.
--
-- Migration 0021 replaces `fulfil_checkout()` with a version that also posts the ledger journal, once
-- the ledger exists. Everything else about it stays the same.
--
-- D12 references: `CO-26-000001` for checkouts and `MP-26-001001` for seller orders, both generated
-- server-side and concurrency-safe.
--
-- D23: a delivered service order auto-completes after the configured buyer-response period;
-- `auto_complete_at` carries the deadline and the pg_cron job in 0032 acts on it.

-- ---------------------------------------------------------------------------------------------------
-- Reference sequences (D12)
-- ---------------------------------------------------------------------------------------------------
create table app_private.reference_sequences (
  prefix text not null,
  year smallint not null,
  next_value bigint not null,
  primary key (prefix, year),
  constraint reference_sequences_prefix_format check (prefix ~ '^[A-Z]{2,4}$'),
  constraint reference_sequences_next_value_positive check (next_value >= 1)
);
comment on table app_private.reference_sequences is
  'Per-prefix, per-year counters behind the human references (D12). One UPDATE ... RETURNING per reference keeps it concurrency-safe.';
alter table app_private.reference_sequences enable row level security;

create or replace function app_private.next_reference(p_prefix text, p_start bigint default 1) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  this_year smallint := extract(year from now())::smallint;
  value bigint;
begin
  insert into app_private.reference_sequences (prefix, year, next_value)
  values (p_prefix, this_year, p_start)
  on conflict (prefix, year)
    do update set next_value = app_private.reference_sequences.next_value + 1
  returning next_value into value;

  return format('%s-%s-%s', p_prefix, to_char(this_year % 100, 'FM00'), to_char(value, 'FM000000'));
end;
$$;
comment on function app_private.next_reference(text, bigint) is
  'The next reference for a prefix in the current year, e.g. CO-26-000001. The row lock the UPDATE takes makes concurrent callers queue rather than collide.';

create or replace function app_private.tg_checkouts_reference() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.reference is null then
    new.reference := app_private.next_reference('CO', 1);
  end if;
  return new;
end;
$$;

alter table public.checkouts alter column reference drop not null;
create trigger checkouts_reference before insert on public.checkouts
  for each row execute function app_private.tg_checkouts_reference();
alter table public.checkouts add constraint checkouts_reference_present check (reference is not null) not valid;
alter table public.checkouts validate constraint checkouts_reference_present;

-- ---------------------------------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------------------------------
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text,
  currency_code char(3) not null,
  checkout_id uuid not null,
  seller_user_id uuid not null references public.seller_profiles (user_id) on delete restrict,
  buyer_user_id uuid not null references auth.users (id) on delete restrict,
  order_type text not null,
  status text not null default 'pending_payment',
  subtotal_minor bigint not null default 0,
  shipping_total_minor bigint not null default 0,
  tax_total_minor bigint not null default 0,
  discount_total_minor bigint not null default 0,
  commission_total_minor bigint not null default 0,
  grand_total_minor bigint not null default 0,
  seller_net_minor bigint not null default 0,
  cancellation_policy_snapshot jsonb,
  commission_snapshot jsonb,
  placed_at timestamptz not null default now(),
  paid_at timestamptz,
  shipped_at timestamptz,
  delivered_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  auto_complete_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (checkout_id, currency_code) references public.checkouts (id, currency_code) on delete restrict,
  constraint orders_number_format check (order_number is null or order_number ~ '^MP-[0-9]{2}-[0-9]{6,}$'),
  constraint orders_type_allowed check (order_type in ('product', 'service')),
  constraint orders_status_matches_type check (
    case order_type
      when 'product' then status in ('pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'completed', 'cancelled', 'refund_requested', 'refunded', 'disputed')
      else status in ('pending_payment', 'requested', 'accepted', 'in_progress', 'delivered', 'revision_requested', 'completed', 'cancelled', 'disputed')
    end
  ),
  constraint orders_amounts_positive check (
    subtotal_minor >= 0 and shipping_total_minor >= 0 and tax_total_minor >= 0 and discount_total_minor >= 0
    and commission_total_minor >= 0 and grand_total_minor >= 0 and seller_net_minor >= 0
  ),
  constraint orders_total_adds_up check (
    grand_total_minor = subtotal_minor + shipping_total_minor + tax_total_minor - discount_total_minor
  ),
  constraint orders_commission_within_total check (commission_total_minor <= grand_total_minor),
  constraint orders_completed_has_time check ((status = 'completed') = (completed_at is not null)),
  constraint orders_cancelled_has_time check ((status = 'cancelled') = (cancelled_at is not null)),
  constraint orders_not_completed_and_cancelled check (completed_at is null or cancelled_at is null),
  unique (checkout_id, seller_user_id),
  unique (id, currency_code)
);
comment on table public.orders is
  'One seller order per (checkout, seller). The unique key is what makes a duplicate fulfilment impossible even if it were attempted.';
comment on column public.orders.auto_complete_at is
  'When a delivered service order completes by itself (D23). NULL until it is delivered.';
create unique index orders_order_number on public.orders (order_number) where order_number is not null;
create index orders_seller on public.orders (seller_user_id, status, placed_at desc);
create index orders_buyer on public.orders (buyer_user_id, placed_at desc);
create index orders_auto_completing on public.orders (auto_complete_at) where auto_complete_at is not null and status = 'delivered';
create trigger orders_set_updated_at before update on public.orders
  for each row execute function app_private.tg_set_updated_at();

create or replace function app_private.tg_orders_reference() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.order_number is null then
    -- Seller order numbers start at 1001 so they never read like a checkout reference (D12).
    new.order_number := app_private.next_reference('MP', 1001);
  end if;
  return new;
end;
$$;

create trigger orders_reference before insert on public.orders
  for each row execute function app_private.tg_orders_reference();

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null,
  currency_code char(3) not null,
  listing_id uuid not null references public.listings (id) on delete restrict,
  listing_type_code text not null references public.listing_types (code) on delete restrict,
  listing_title_snapshot text not null,
  listing_slug_snapshot text not null,
  quantity integer not null,
  cancelled_quantity integer not null default 0,
  unit_price_minor bigint not null,
  line_subtotal_minor bigint not null,
  discount_minor bigint not null default 0,
  tax_minor bigint not null default 0,
  line_total_minor bigint not null,
  commission_minor bigint not null default 0,
  created_at timestamptz not null default now(),
  foreign key (order_id, currency_code) references public.orders (id, currency_code) on delete cascade,
  constraint order_items_quantity_positive check (quantity >= 1),
  constraint order_items_cancelled_within_quantity check (cancelled_quantity between 0 and quantity),
  constraint order_items_amounts_positive check (
    unit_price_minor >= 0 and line_subtotal_minor >= 0 and discount_minor >= 0
    and tax_minor >= 0 and line_total_minor >= 0 and commission_minor >= 0
  ),
  constraint order_items_subtotal_matches check (line_subtotal_minor = unit_price_minor * quantity),
  constraint order_items_total_adds_up check (line_total_minor = line_subtotal_minor - discount_minor + tax_minor),
  unique (order_id, listing_id)
);
create index order_items_listing on public.order_items (listing_id);

create table public.order_status_history (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders (id) on delete cascade,
  from_status text,
  to_status text not null,
  changed_by uuid references auth.users (id) on delete set null,
  reason text,
  changed_at timestamptz not null default now()
);
comment on table public.order_status_history is 'Append-only order lifecycle trail, written by a trigger so no path can skip it.';
create index order_status_history_order on public.order_status_history (order_id, changed_at desc);
create trigger order_status_history_append_only before update or delete on public.order_status_history
  for each row execute function app_private.tg_reject_write();

create or replace function app_private.tg_orders_status_change() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  response_hours integer;
begin
  insert into public.order_status_history (order_id, from_status, to_status, changed_by)
  values (new.id, case when tg_op = 'UPDATE' then old.status end, new.status, public.current_user_id());

  -- D23: a delivered service order completes by itself after the configured buyer-response period.
  if new.order_type = 'service' and new.status = 'delivered' and new.auto_complete_at is null then
    response_hours := coalesce((public.site_setting('orders.service_buyer_response_hours'))::integer, 72);
    update public.orders set auto_complete_at = coalesce(new.delivered_at, now()) + make_interval(hours => response_hours)
     where id = new.id;
  end if;

  perform public.enqueue_outbox_event(
    'order', new.id::text, format('order.%s', new.status),
    jsonb_build_object('order_id', new.id, 'seller_user_id', new.seller_user_id, 'buyer_user_id', new.buyer_user_id, 'status', new.status)
  );
  return null;
end;
$$;

create trigger orders_status_change after insert or update of status on public.orders
  for each row execute function app_private.tg_orders_status_change();

-- ---------------------------------------------------------------------------------------------------
-- Shipments and service deliveries
-- ---------------------------------------------------------------------------------------------------
create table public.order_shipments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  carrier text,
  tracking_number text,
  tracking_url text,
  status text not null default 'pending',
  shipped_at timestamptz,
  delivered_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint order_shipments_status_allowed check (status in ('pending', 'dispatched', 'in_transit', 'delivered', 'returned', 'lost')),
  constraint order_shipments_tracking_url_shape check (tracking_url is null or tracking_url ~ '^https://'),
  constraint order_shipments_dispatch_has_time check (status = 'pending' or shipped_at is not null),
  constraint order_shipments_delivered_has_time check ((status = 'delivered') = (delivered_at is not null)),
  constraint order_shipments_delivery_after_dispatch check (delivered_at is null or shipped_at is null or delivered_at >= shipped_at)
);
create index order_shipments_order on public.order_shipments (order_id, created_at);
create trigger order_shipments_set_updated_at before update on public.order_shipments
  for each row execute function app_private.tg_set_updated_at();

create table public.service_deliveries (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  revision_round smallint not null default 0,
  delivered_by uuid not null references auth.users (id) on delete restrict,
  delivery_note text not null,
  attachment_paths text[] not null default '{}'::text[],
  delivered_at timestamptz not null default now(),
  accepted_at timestamptz,
  revision_requested_at timestamptz,
  revision_note text,
  constraint service_deliveries_note_length check (length(btrim(delivery_note)) between 1 and 5000),
  constraint service_deliveries_revision_round_positive check (revision_round >= 0),
  constraint service_deliveries_one_outcome check (accepted_at is null or revision_requested_at is null),
  constraint service_deliveries_revision_has_note check (
    revision_requested_at is null or length(btrim(coalesce(revision_note, ''))) > 0
  ),
  unique (order_id, revision_round)
);
comment on table public.service_deliveries is
  'One row per delivery round of a service order. Attachments live in a private bucket and are reached only through signed URLs.';
create index service_deliveries_order on public.service_deliveries (order_id, revision_round desc);

-- ---------------------------------------------------------------------------------------------------
-- Cancellations
-- ---------------------------------------------------------------------------------------------------
create table public.order_cancellations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null,
  currency_code char(3) not null,
  order_item_id uuid references public.order_items (id) on delete cascade,
  requested_by uuid references auth.users (id) on delete set null,
  requester_role text not null,
  reason text not null,
  status text not null default 'requested',
  quantity integer,
  refund_percentage_basis_points integer not null,
  refund_amount_minor bigint not null default 0,
  policy_snapshot jsonb not null,
  decided_at timestamptz,
  decided_by uuid references auth.users (id) on delete set null,
  decision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (order_id, currency_code) references public.orders (id, currency_code) on delete cascade,
  constraint order_cancellations_requester_role_allowed check (requester_role in ('buyer', 'seller', 'admin', 'system')),
  constraint order_cancellations_status_allowed check (status in ('requested', 'approved', 'rejected', 'completed')),
  constraint order_cancellations_reason_length check (length(btrim(reason)) between 1 and 2000),
  constraint order_cancellations_refund_range check (refund_percentage_basis_points between 0 and 10000),
  constraint order_cancellations_refund_positive check (refund_amount_minor >= 0),
  constraint order_cancellations_quantity_positive check (quantity is null or quantity >= 1),
  constraint order_cancellations_quantity_needs_item check (quantity is null or order_item_id is not null),
  constraint order_cancellations_decided_has_decider check (decided_at is null or decided_by is not null),
  constraint order_cancellations_decided_has_time check ((status in ('approved', 'rejected')) = (decided_at is not null)),
  constraint order_cancellations_policy_is_object check (jsonb_typeof(policy_snapshot) = 'object')
);
comment on table public.order_cancellations is
  'Cancellations apply per seller order or per item, always under the policy snapshotted on the order rather than the policy in force today.';
create index order_cancellations_order on public.order_cancellations (order_id, created_at desc);
create index order_cancellations_queue on public.order_cancellations (status, created_at) where status = 'requested';
create trigger order_cancellations_set_updated_at before update on public.order_cancellations
  for each row execute function app_private.tg_set_updated_at();
create trigger order_cancellations_audit after insert or update on public.order_cancellations
  for each row execute function audit.tg_record_change('reason', 'decision_note');

-- ---------------------------------------------------------------------------------------------------
-- Fulfilment (C4: one function, one transaction, across modules)
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

  for seller in
    select
      ci.seller_user_id,
      case when bool_or(ci.listing_type_code <> 'service') then 'product' else 'service' end as order_type,
      sum(ci.line_subtotal_minor)::bigint as subtotal_minor,
      sum(ci.discount_minor)::bigint as discount_minor,
      sum(ci.tax_minor)::bigint as tax_minor,
      coalesce((select sum(cc.amount_minor) from public.checkout_charges cc
                 where cc.checkout_id = p_checkout_id and cc.charge_type = 'shipping'
                   and cc.seller_user_id = ci.seller_user_id), 0)::bigint as shipping_minor
    from public.checkout_items ci
    where ci.checkout_id = p_checkout_id
    group by ci.seller_user_id
    order by ci.seller_user_id
  loop
    insert into public.orders (
      currency_code, checkout_id, seller_user_id, buyer_user_id, order_type, status,
      subtotal_minor, shipping_total_minor, tax_total_minor, discount_total_minor, grand_total_minor,
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
      seller.subtotal_minor + seller.shipping_minor + seller.tax_minor - seller.discount_minor,
      checkout.cancellation_policy_snapshot,
      checkout.commission_snapshot,
      now()
    )
    returning id into new_order_id;

    insert into public.order_items (
      order_id, currency_code, listing_id, listing_type_code, listing_title_snapshot, listing_slug_snapshot,
      quantity, unit_price_minor, line_subtotal_minor, discount_minor, tax_minor, line_total_minor
    )
    select
      new_order_id, checkout.currency_code, ci.listing_id, ci.listing_type_code,
      ci.listing_title_snapshot, ci.listing_slug_snapshot,
      ci.quantity, ci.unit_price_minor, ci.line_subtotal_minor, ci.discount_minor, ci.tax_minor, ci.line_total_minor
    from public.checkout_items ci
    where ci.checkout_id = p_checkout_id and ci.seller_user_id = seller.seller_user_id;

    orders_created := orders_created + 1;
  end loop;

  if orders_created = 0 then
    raise exception 'checkout % has no items to fulfil', p_checkout_id using errcode = 'restrict_violation';
  end if;

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
  'The single fulfilment path: seller orders, order items, stock decrements, reservation consumption and outbox events in one transaction. Migration 0021 adds the ledger journal.';

create or replace function app_private.complete_due_service_orders(p_limit integer default 200) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  completed integer;
begin
  with due as (
    select o.id from public.orders o
     where o.order_type = 'service'
       and o.status = 'delivered'
       and o.auto_complete_at is not null
       and o.auto_complete_at <= now()
     order by o.auto_complete_at
     limit p_limit
     for update skip locked
  )
  update public.orders o
     set status = 'completed', completed_at = now()
    from due
   where o.id = due.id;
  get diagnostics completed = row_count;
  return completed;
end;
$$;
comment on function app_private.complete_due_service_orders(integer) is
  'D23: completes delivered service orders whose buyer-response period has passed. Scheduled by pg_cron in 0032.';

select app_private.register_currency_dependency(
  'orders.currency_code', 'public', 'orders', 'currency_code',
  'orders in the currency that are not yet finished',
  $$status not in ('cancelled', 'refunded')$$
);

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_status_history enable row level security;
alter table public.order_shipments enable row level security;
alter table public.service_deliveries enable row level security;
alter table public.order_cancellations enable row level security;

create policy orders_party_read on public.orders for select to authenticated
  using (buyer_user_id = public.current_user_id() or seller_user_id = public.current_user_id());
create policy orders_staff_read on public.orders for select to authenticated
  using (public.has_permission('orders.order.read'));
create policy orders_seller_update on public.orders for update to authenticated
  using (seller_user_id = public.current_user_id())
  with check (seller_user_id = public.current_user_id());
create policy orders_staff_update on public.orders for update to authenticated
  using (public.has_permission('orders.order.manage') and public.is_aal2())
  with check (public.has_permission('orders.order.manage') and public.is_aal2());

create policy order_items_party_read on public.order_items for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_id and (o.buyer_user_id = public.current_user_id() or o.seller_user_id = public.current_user_id())
  ));
create policy order_items_staff_read on public.order_items for select to authenticated
  using (public.has_permission('orders.order.read'));

create policy order_status_history_party_read on public.order_status_history for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_id and (o.buyer_user_id = public.current_user_id() or o.seller_user_id = public.current_user_id())
  ));

create policy order_shipments_party_read on public.order_shipments for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_id and (o.buyer_user_id = public.current_user_id() or o.seller_user_id = public.current_user_id())
  ));
create policy order_shipments_seller_write on public.order_shipments for all to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and o.seller_user_id = public.current_user_id()))
  with check (exists (select 1 from public.orders o where o.id = order_id and o.seller_user_id = public.current_user_id()));

create policy service_deliveries_party_read on public.service_deliveries for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_id and (o.buyer_user_id = public.current_user_id() or o.seller_user_id = public.current_user_id())
  ));
create policy service_deliveries_seller_insert on public.service_deliveries for insert to authenticated
  with check (
    delivered_by = public.current_user_id()
    and exists (select 1 from public.orders o where o.id = order_id and o.seller_user_id = public.current_user_id())
  );
create policy service_deliveries_buyer_update on public.service_deliveries for update to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and o.buyer_user_id = public.current_user_id()))
  with check (exists (select 1 from public.orders o where o.id = order_id and o.buyer_user_id = public.current_user_id()));

create policy order_cancellations_party_read on public.order_cancellations for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_id and (o.buyer_user_id = public.current_user_id() or o.seller_user_id = public.current_user_id())
  ));
create policy order_cancellations_party_insert on public.order_cancellations for insert to authenticated
  with check (
    requested_by = public.current_user_id()
    and exists (
      select 1 from public.orders o
      where o.id = order_id and (o.buyer_user_id = public.current_user_id() or o.seller_user_id = public.current_user_id())
    )
  );
create policy order_cancellations_staff_update on public.order_cancellations for update to authenticated
  using (public.has_permission('orders.cancellation.manage') and public.is_aal2())
  with check (public.has_permission('orders.cancellation.manage') and public.is_aal2());

grant select, update on public.orders to authenticated;
grant select on public.order_items to authenticated;
grant select on public.order_status_history to authenticated;
grant select, insert, update, delete on public.order_shipments to authenticated;
grant select, insert, update on public.service_deliveries to authenticated;
grant select, insert, update on public.order_cancellations to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function
  app_private.fulfil_checkout(uuid, uuid),
  app_private.complete_due_service_orders(integer),
  app_private.next_reference(text, bigint)
  to app_system, app_worker;
