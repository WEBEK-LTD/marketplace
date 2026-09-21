-- 0024 — Coupons: definitions, their per-currency amounts, redemption records, and the checkout
-- integration that applies one (v5.2 "Checkout pricing pipeline" step 2, Coupons module; D11, D14, D16,
-- C10).
--
-- A coupon is either platform-funded or seller-funded, and the funding source is stored on every record
-- it touches, because D11 turns on it: a seller-funded discount reduces the commission base, a
-- platform-funded one does not. A seller-funded coupon can only ever discount that seller's own lines —
-- nobody funds a discount on someone else's goods — and that restriction is applied in the same query
-- that computes the discount, not left to the caller.
--
-- Amounts are per currency, in the same shape 0016 uses for commission components: a fixed coupon with
-- no amount configured for the checkout's currency is simply not applicable, fail-closed, rather than
-- being converted at some rate nobody approved (D16). A percentage coupon works in any currency, and its
-- cap and minimum are per currency too.
--
-- Rounding follows D14: half-up, computed once on the eligible subtotal in integer minor units.
--
-- `coupon_usage` is append-only like every other financial record here. A coupon is redeemed when it is
-- applied to a checkout; if that checkout is abandoned the redemption is given back by appending a
-- reversing row, never by deleting or editing the original. `coupons.redemption_count` is maintained
-- from those rows by trigger, and the limits are checked under a row lock on the coupon, so two buyers
-- racing for the last redemption cannot both win.
--
-- Applying is idempotent (C10): the same coupon on the same checkout returns the discount already
-- recorded rather than discounting twice. The discount itself lands in `checkout_charges` as a negative
-- row carrying `funding_source`, `source_type = 'coupon'` and the coupon id, which is the shape 0017
-- already defined — no completed migration is reopened here.

-- ---------------------------------------------------------------------------------------------------
-- Category containment (D8: one tree, three levels)
-- ---------------------------------------------------------------------------------------------------
create or replace function public.category_is_within(
  p_category_id uuid,
  p_ancestor_id uuid
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with recursive lineage as (
    select c.id, c.parent_id from public.categories c where c.id = p_category_id
    union all
    select c.id, c.parent_id from public.categories c join lineage l on c.id = l.parent_id
  )
  select exists (select 1 from lineage where id = p_ancestor_id);
$$;
comment on function public.category_is_within(uuid, uuid) is
  'Whether a category is the given category or sits under it. A coupon scoped to a branch reaches the whole branch, not only its exact node.';

-- ---------------------------------------------------------------------------------------------------
-- Coupons
-- ---------------------------------------------------------------------------------------------------
create table public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  discount_type text not null,
  percentage_basis_points integer,
  funding_source text not null,
  funded_by_seller_user_id uuid references public.seller_profiles (user_id) on delete restrict,
  scope text not null default 'all',
  category_id uuid references public.categories (id) on delete restrict,
  listing_id uuid references public.listings (id) on delete restrict,
  listing_type_code text references public.listing_types (code) on delete restrict,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  max_redemptions integer,
  max_redemptions_per_user integer,
  redemption_count integer not null default 0,
  is_active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint coupons_code_format check (code ~* '^[a-z0-9][a-z0-9_-]{2,31}$'),
  constraint coupons_name_length check (length(btrim(name)) between 1 and 120),
  constraint coupons_discount_type_allowed check (discount_type in ('percentage', 'fixed')),
  constraint coupons_percentage_present check (
    (discount_type = 'percentage') = (percentage_basis_points is not null)
  ),
  constraint coupons_percentage_range check (
    percentage_basis_points is null or percentage_basis_points between 1 and 10000
  ),
  constraint coupons_funding_source_allowed check (funding_source in ('platform', 'seller')),
  -- D11: a seller-funded coupon names its funder, a platform-funded one never does.
  constraint coupons_seller_funded_names_the_seller check (
    (funding_source = 'seller') = (funded_by_seller_user_id is not null)
  ),
  constraint coupons_scope_allowed check (scope in ('all', 'category', 'listing', 'listing_type')),
  constraint coupons_scope_target check (
    case scope
      when 'category' then category_id is not null and listing_id is null and listing_type_code is null
      when 'listing' then listing_id is not null and category_id is null and listing_type_code is null
      when 'listing_type' then listing_type_code is not null and category_id is null and listing_id is null
      else category_id is null and listing_id is null and listing_type_code is null
    end
  ),
  constraint coupons_window_order check (ends_at is null or ends_at > starts_at),
  constraint coupons_max_redemptions_positive check (max_redemptions is null or max_redemptions >= 1),
  constraint coupons_max_per_user_positive check (max_redemptions_per_user is null or max_redemptions_per_user >= 1),
  constraint coupons_redemption_count_not_negative check (redemption_count >= 0)
);
comment on table public.coupons is
  'Coupon definitions. `funding_source` decides who pays for the discount and therefore whether it reduces the commission base (D11); a seller-funded coupon only ever discounts its funder''s own lines.';
comment on column public.coupons.redemption_count is
  'Maintained from coupon_usage by trigger, releases included. It is a cache of those rows, and those rows are the record.';
comment on column public.coupons.scope is
  'What the coupon reaches. A category scope reaches the whole branch beneath it (D8).';
create unique index coupons_code on public.coupons (upper(code));
create index coupons_live on public.coupons (starts_at, ends_at) where is_active;
create index coupons_funder on public.coupons (funded_by_seller_user_id) where funded_by_seller_user_id is not null;
create trigger coupons_set_updated_at before update on public.coupons
  for each row execute function app_private.tg_set_updated_at();
create trigger coupons_audit after insert or update or delete on public.coupons
  for each row execute function audit.tg_record_change();

create table public.coupon_amounts (
  coupon_id uuid not null references public.coupons (id) on delete cascade,
  currency_code char(3) not null references public.currencies (code) on delete restrict,
  amount_minor bigint,
  min_order_amount_minor bigint,
  max_discount_amount_minor bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (coupon_id, currency_code),
  constraint coupon_amounts_amount_positive check (amount_minor is null or amount_minor > 0),
  constraint coupon_amounts_bounds_positive check (
    (min_order_amount_minor is null or min_order_amount_minor >= 0)
    and (max_discount_amount_minor is null or max_discount_amount_minor > 0)
  )
);
comment on table public.coupon_amounts is
  'Per-currency amounts. A fixed coupon needs a row here for the checkout currency or it simply does not apply; a percentage coupon uses this only for its minimum and its cap (D16).';
create trigger coupon_amounts_set_updated_at before update on public.coupon_amounts
  for each row execute function app_private.tg_set_updated_at();
create trigger coupon_amounts_audit after insert or update or delete on public.coupon_amounts
  for each row execute function audit.tg_record_change();

-- A fixed coupon is only usable where an amount exists, so the pairing is checked as it is written.
create or replace function app_private.tg_coupon_amounts_fit_type() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  coupon public.coupons;
begin
  select * into coupon from public.coupons c where c.id = new.coupon_id;
  if coupon.discount_type = 'fixed' and new.amount_minor is null then
    raise exception 'a fixed coupon needs an amount for %', new.currency_code using errcode = 'check_violation';
  end if;
  if coupon.discount_type = 'percentage' and new.amount_minor is not null then
    raise exception 'a percentage coupon carries its rate on the coupon, not an amount per currency'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger coupon_amounts_fit_type before insert or update on public.coupon_amounts
  for each row execute function app_private.tg_coupon_amounts_fit_type();

-- ---------------------------------------------------------------------------------------------------
-- Redemptions
-- ---------------------------------------------------------------------------------------------------
create table public.coupon_usage (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons (id) on delete restrict,
  currency_code char(3) not null,
  user_id uuid not null references auth.users (id) on delete restrict,
  checkout_id uuid not null,
  order_id uuid references public.orders (id) on delete set null,
  discount_minor bigint not null,
  funding_source text not null,
  funded_by_seller_user_id uuid references public.seller_profiles (user_id) on delete restrict,
  reverses_usage_id uuid references public.coupon_usage (id) on delete restrict,
  release_reason text,
  created_at timestamptz not null default now(),
  foreign key (checkout_id, currency_code) references public.checkouts (id, currency_code) on delete restrict,
  constraint coupon_usage_discount_positive check (discount_minor > 0),
  constraint coupon_usage_funding_source_allowed check (funding_source in ('platform', 'seller')),
  constraint coupon_usage_seller_funded_names_the_seller check (
    (funding_source = 'seller') = (funded_by_seller_user_id is not null)
  ),
  constraint coupon_usage_release_has_reason check (
    (reverses_usage_id is null) or length(btrim(release_reason)) > 0
  ),
  constraint coupon_usage_not_self_reversing check (reverses_usage_id is null or reverses_usage_id <> id)
);
comment on table public.coupon_usage is
  'One row per redemption, append-only. Giving a redemption back is a reversing row, so the history of who used what is never rewritten.';
comment on column public.coupon_usage.funding_source is
  'Snapshotted from the coupon, because D11''s commission base depends on it and a later edit to the coupon must not change a priced checkout.';
-- The idempotency key of the whole feature: one live redemption of one coupon per checkout.
create unique index coupon_usage_one_per_checkout on public.coupon_usage (coupon_id, checkout_id)
  where reverses_usage_id is null;
create unique index coupon_usage_one_release on public.coupon_usage (reverses_usage_id)
  where reverses_usage_id is not null;
create index coupon_usage_by_user on public.coupon_usage (coupon_id, user_id) where reverses_usage_id is null;
create index coupon_usage_by_checkout on public.coupon_usage (checkout_id);
create trigger coupon_usage_append_only before update or delete on public.coupon_usage
  for each row execute function app_private.tg_reject_write();

create or replace function app_private.tg_coupon_usage_count() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.coupons
     set redemption_count = redemption_count + case when new.reverses_usage_id is null then 1 else -1 end
   where id = new.coupon_id;
  return null;
end;
$$;
comment on function app_private.tg_coupon_usage_count() is
  'Keeps the redemption counter in step with the rows it counts: a redemption adds one, a release takes one back.';

create trigger coupon_usage_count after insert on public.coupon_usage
  for each row execute function app_private.tg_coupon_usage_count();

-- ---------------------------------------------------------------------------------------------------
-- What a coupon is worth on a checkout
-- ---------------------------------------------------------------------------------------------------
create or replace function public.coupon_eligible_subtotal(
  p_coupon_id uuid,
  p_checkout_id uuid
) returns bigint
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(sum(ci.line_subtotal_minor - ci.discount_minor), 0)::bigint
    from public.checkout_items ci
    join public.listings l on l.id = ci.listing_id
    join public.coupons c on c.id = p_coupon_id
   where ci.checkout_id = p_checkout_id
     -- A seller-funded coupon never reaches another seller's lines (D11).
     and (c.funding_source <> 'seller' or ci.seller_user_id = c.funded_by_seller_user_id)
     and case c.scope
           when 'category' then public.category_is_within(l.category_id, c.category_id)
           when 'listing' then ci.listing_id = c.listing_id
           when 'listing_type' then ci.listing_type_code = c.listing_type_code
           else true
         end;
$$;
comment on function public.coupon_eligible_subtotal(uuid, uuid) is
  'The part of a checkout this coupon may discount, after any discount already on those lines.';

create or replace function public.coupon_check(
  p_code text,
  p_checkout_id uuid
)
returns table (
  coupon_id uuid,
  is_applicable boolean,
  reason text,
  discount_minor bigint,
  funding_source text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  coupon public.coupons;
  checkout public.checkouts;
  amounts public.coupon_amounts;
  eligible bigint;
  computed bigint;
  used_by_user integer;
begin
  select * into checkout from public.checkouts c where c.id = p_checkout_id;
  if checkout.id is null then
    return query select null::uuid, false, 'checkout_not_found', 0::bigint, null::text;
    return;
  end if;

  select * into coupon from public.coupons c where upper(c.code) = upper(btrim(p_code));
  if coupon.id is null then
    return query select null::uuid, false, 'unknown_code', 0::bigint, null::text;
    return;
  end if;

  -- Everything below fails closed: a coupon is applicable only when every rule says so.
  if not coupon.is_active then
    return query select coupon.id, false, 'inactive', 0::bigint, coupon.funding_source;
    return;
  end if;
  if coupon.starts_at > now() or (coupon.ends_at is not null and coupon.ends_at <= now()) then
    return query select coupon.id, false, 'outside_window', 0::bigint, coupon.funding_source;
    return;
  end if;
  if coupon.max_redemptions is not null and coupon.redemption_count >= coupon.max_redemptions then
    return query select coupon.id, false, 'redemption_limit_reached', 0::bigint, coupon.funding_source;
    return;
  end if;

  select count(*) into used_by_user
    from public.coupon_usage u
   where u.coupon_id = coupon.id
     and u.user_id = checkout.buyer_user_id
     and u.reverses_usage_id is null
     and not exists (select 1 from public.coupon_usage r where r.reverses_usage_id = u.id);
  if coupon.max_redemptions_per_user is not null and used_by_user >= coupon.max_redemptions_per_user then
    return query select coupon.id, false, 'user_limit_reached', 0::bigint, coupon.funding_source;
    return;
  end if;

  select * into amounts from public.coupon_amounts a
   where a.coupon_id = coupon.id and a.currency_code = checkout.currency_code;

  -- D16: a fixed coupon with no amount in this currency is not converted, it simply does not apply.
  if coupon.discount_type = 'fixed' and amounts.amount_minor is null then
    return query select coupon.id, false, 'currency_not_configured', 0::bigint, coupon.funding_source;
    return;
  end if;

  if amounts.min_order_amount_minor is not null and checkout.subtotal_minor < amounts.min_order_amount_minor then
    return query select coupon.id, false, 'below_minimum_order', 0::bigint, coupon.funding_source;
    return;
  end if;

  eligible := public.coupon_eligible_subtotal(coupon.id, p_checkout_id);
  if eligible <= 0 then
    return query select coupon.id, false, 'no_eligible_items', 0::bigint, coupon.funding_source;
    return;
  end if;

  if coupon.discount_type = 'percentage' then
    -- D14: half-up, in minor units, computed once.
    computed := (eligible * coupon.percentage_basis_points + 5000) / 10000;
  else
    computed := amounts.amount_minor;
  end if;

  if amounts.max_discount_amount_minor is not null then
    computed := least(computed, amounts.max_discount_amount_minor);
  end if;
  computed := least(computed, eligible);

  if computed <= 0 then
    return query select coupon.id, false, 'nothing_to_discount', 0::bigint, coupon.funding_source;
    return;
  end if;

  return query select coupon.id, true, null::text, computed, coupon.funding_source;
end;
$$;
comment on function public.coupon_check(text, uuid) is
  'Whether a code applies to a checkout and what it would be worth, without applying it. Every refusal names its reason, so the storefront can say why rather than only that it failed.';

-- ---------------------------------------------------------------------------------------------------
-- Applying and releasing
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.apply_coupon(
  p_checkout_id uuid,
  p_code text
) returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  checkout public.checkouts;
  coupon public.coupons;
  verdict record;
  existing_discount bigint;
  discount bigint;
begin
  select * into checkout from public.checkouts c where c.id = p_checkout_id for update;
  if checkout.id is null then
    raise exception 'checkout % does not exist', p_checkout_id using errcode = 'no_data_found';
  end if;
  if checkout.status <> 'open' then
    raise exception 'checkout % is % and can no longer be repriced', p_checkout_id, checkout.status
      using errcode = 'restrict_violation';
  end if;

  select * into coupon from public.coupons c where upper(c.code) = upper(btrim(p_code));
  if coupon.id is null then
    raise exception 'no coupon with that code' using errcode = 'restrict_violation';
  end if;

  -- C10: the same coupon on the same checkout gives back what it already gave, never a second discount.
  select u.discount_minor into existing_discount
    from public.coupon_usage u
   where u.coupon_id = coupon.id
     and u.checkout_id = p_checkout_id
     and u.reverses_usage_id is null
     and not exists (select 1 from public.coupon_usage r where r.reverses_usage_id = u.id);
  if existing_discount is not null then
    return existing_discount;
  end if;

  -- The row lock is what makes the last redemption go to exactly one buyer.
  perform 1 from public.coupons c where c.id = coupon.id for update;

  select * into verdict from public.coupon_check(p_code, p_checkout_id);
  if not verdict.is_applicable then
    raise exception 'coupon is not applicable: %', verdict.reason using errcode = 'restrict_violation';
  end if;
  discount := verdict.discount_minor;

  insert into public.checkout_charges (
    checkout_id, currency_code, charge_type, seller_user_id, label, amount_minor,
    source_type, source_id, funding_source
  )
  values (
    p_checkout_id, checkout.currency_code, 'discount',
    coupon.funded_by_seller_user_id, upper(coupon.code), -discount,
    'coupon', coupon.id, coupon.funding_source
  );

  insert into public.coupon_usage (
    coupon_id, currency_code, user_id, checkout_id, discount_minor, funding_source, funded_by_seller_user_id
  )
  values (
    coupon.id, checkout.currency_code, checkout.buyer_user_id, p_checkout_id, discount,
    coupon.funding_source, coupon.funded_by_seller_user_id
  );

  update public.checkouts c
     set discount_total_minor = c.discount_total_minor + discount,
         grand_total_minor = c.subtotal_minor + c.shipping_total_minor + c.tax_total_minor
                             + c.buyer_fee_total_minor - (c.discount_total_minor + discount)
   where c.id = p_checkout_id;

  perform public.enqueue_outbox_event(
    'coupon', coupon.id::text, 'coupon.redeemed',
    jsonb_build_object('coupon_id', coupon.id, 'checkout_id', p_checkout_id,
                       'user_id', checkout.buyer_user_id, 'currency_code', checkout.currency_code,
                       'discount_minor', discount, 'funding_source', coupon.funding_source)
  );
  return discount;
end;
$$;
comment on function app_private.apply_coupon(uuid, text) is
  'Applies a coupon to an open checkout: the discount charge, the redemption record and the checkout totals all move in one transaction, under a row lock on the coupon so its limits hold under load.';

create or replace function app_private.release_coupon_usage(
  p_checkout_id uuid,
  p_reason text
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  usage record;
  released integer := 0;
begin
  for usage in
    select u.*
      from public.coupon_usage u
     where u.checkout_id = p_checkout_id
       and u.reverses_usage_id is null
       and not exists (select 1 from public.coupon_usage r where r.reverses_usage_id = u.id)
     order by u.created_at
  loop
    insert into public.coupon_usage (
      coupon_id, currency_code, user_id, checkout_id, discount_minor, funding_source,
      funded_by_seller_user_id, reverses_usage_id, release_reason
    )
    values (
      usage.coupon_id, usage.currency_code, usage.user_id, p_checkout_id, usage.discount_minor,
      usage.funding_source, usage.funded_by_seller_user_id, usage.id, p_reason
    );
    released := released + 1;
  end loop;

  return released;
end;
$$;
comment on function app_private.release_coupon_usage(uuid, text) is
  'Gives back the redemptions a checkout held, by appending a reversing row for each. Nothing is edited or deleted, and the counter follows automatically.';

-- ---------------------------------------------------------------------------------------------------
-- Currency dependencies (D16)
-- ---------------------------------------------------------------------------------------------------
select app_private.register_currency_dependency(
  'coupon_amounts.currency_code', 'public', 'coupon_amounts', 'currency_code',
  'coupon amounts configured for the currency'
);

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table public.coupons enable row level security;
alter table public.coupon_amounts enable row level security;
alter table public.coupon_usage enable row level security;

create policy coupons_staff_read on public.coupons for select to authenticated
  using (public.has_permission('marketing.coupon.read'));
create policy coupons_funder_read on public.coupons for select to authenticated
  using (funded_by_seller_user_id = public.current_user_id());
create policy coupons_staff_write on public.coupons for all to authenticated
  using (public.has_permission('marketing.coupon.manage') and public.is_aal2())
  with check (public.has_permission('marketing.coupon.manage') and public.is_aal2());

create policy coupon_amounts_staff_read on public.coupon_amounts for select to authenticated
  using (public.has_permission('marketing.coupon.read'));
create policy coupon_amounts_funder_read on public.coupon_amounts for select to authenticated
  using (exists (
    select 1 from public.coupons c
     where c.id = coupon_id and c.funded_by_seller_user_id = public.current_user_id()
  ));
create policy coupon_amounts_staff_write on public.coupon_amounts for all to authenticated
  using (public.has_permission('marketing.coupon.manage') and public.is_aal2())
  with check (public.has_permission('marketing.coupon.manage') and public.is_aal2());

create policy coupon_usage_self_read on public.coupon_usage for select to authenticated
  using (user_id = public.current_user_id());
create policy coupon_usage_funder_read on public.coupon_usage for select to authenticated
  using (funded_by_seller_user_id = public.current_user_id());
create policy coupon_usage_staff_read on public.coupon_usage for select to authenticated
  using (public.has_permission('marketing.coupon.read'));

grant select, insert, update, delete on public.coupons to authenticated;
grant select, insert, update, delete on public.coupon_amounts to authenticated;
grant select on public.coupon_usage to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function
  public.category_is_within(uuid, uuid),
  public.coupon_eligible_subtotal(uuid, uuid),
  public.coupon_check(text, uuid)
  to authenticated;

grant execute on function
  public.category_is_within(uuid, uuid),
  public.coupon_eligible_subtotal(uuid, uuid),
  public.coupon_check(text, uuid),
  app_private.apply_coupon(uuid, text),
  app_private.release_coupon_usage(uuid, text)
  to app_system, app_worker;
