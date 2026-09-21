-- 0016 — Tax rules, commission rules and amounts, cancellation policies (v5.2 migration plan).
--
-- All three are configurable, as the money policies require. Percentages are stored in basis points so
-- nothing is ever a float; fixed amounts are integer minor units with an explicit currency.
--
-- D27 is implemented by `resolve_commission_components()`: a fixed component that has no amount for the
-- checkout currency is skipped while the other components still apply, and the caller records why
-- through `record_commission_skip()`.
--
-- D11 (seller-funded discounts reduce the commission base, platform-funded ones do not) is a property of
-- the coupon that funded the discount; the funding source lands with coupons in 0024. Nothing here
-- assumes one or the other.

-- ---------------------------------------------------------------------------------------------------
-- Tax rules
-- ---------------------------------------------------------------------------------------------------
create table public.tax_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  country_code char(2) not null references public.countries (code) on delete restrict,
  governorate text,
  category_id uuid references public.categories (id) on delete restrict,
  listing_type_code text references public.listing_types (code) on delete restrict,
  rate_basis_points integer not null,
  is_price_inclusive boolean not null default false,
  priority integer not null default 0,
  effective_from date not null default current_date,
  effective_to date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tax_rules_name_length check (length(btrim(name)) between 1 and 120),
  constraint tax_rules_rate_range check (rate_basis_points between 0 and 10000),
  constraint tax_rules_effective_order check (effective_to is null or effective_to > effective_from)
);
comment on table public.tax_rules is
  'Configurable tax. `rate_basis_points` is hundredths of a percent, so 1400 is 14%. The most specific active rule with the highest priority wins.';
create index tax_rules_lookup on public.tax_rules (country_code, listing_type_code, category_id, priority desc) where is_active;
create trigger tax_rules_set_updated_at before update on public.tax_rules
  for each row execute function app_private.tg_set_updated_at();
create trigger tax_rules_audit after insert or update or delete on public.tax_rules
  for each row execute function audit.tg_record_change();

create or replace function public.resolve_tax_rule(
  p_country_code char(2),
  p_governorate text default null,
  p_category_id uuid default null,
  p_listing_type_code text default null,
  p_on date default null
) returns public.tax_rules
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select t.*
    from public.tax_rules t
   where t.is_active
     and t.country_code = p_country_code
     and (t.governorate is null or t.governorate = p_governorate)
     and (t.category_id is null or t.category_id = p_category_id)
     and (t.listing_type_code is null or t.listing_type_code = p_listing_type_code)
     and t.effective_from <= coalesce(p_on, current_date)
     and (t.effective_to is null or t.effective_to > coalesce(p_on, current_date))
   order by
     t.priority desc,
     (t.governorate is not null) desc,
     (t.category_id is not null) desc,
     (t.listing_type_code is not null) desc,
     t.effective_from desc
   limit 1;
$$;
comment on function public.resolve_tax_rule(char, text, uuid, text, date) is
  'The single tax rule that applies, most specific first. NULL means no tax rule is configured for that combination.';

-- ---------------------------------------------------------------------------------------------------
-- Commission rules
-- ---------------------------------------------------------------------------------------------------
create table public.commission_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  scope text not null,
  category_id uuid references public.categories (id) on delete restrict,
  seller_user_id uuid references public.seller_profiles (user_id) on delete cascade,
  listing_type_code text references public.listing_types (code) on delete restrict,
  component_type text not null,
  percentage_basis_points integer,
  priority integer not null default 0,
  effective_from date not null default current_date,
  effective_to date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commission_rules_name_length check (length(btrim(name)) between 1 and 120),
  constraint commission_rules_scope_allowed check (scope in ('platform', 'category', 'seller', 'listing_type')),
  constraint commission_rules_component_type_allowed check (component_type in ('percentage', 'fixed')),
  constraint commission_rules_percentage_range check (
    percentage_basis_points is null or percentage_basis_points between 0 and 10000
  ),
  constraint commission_rules_percentage_present check (
    (component_type = 'percentage') = (percentage_basis_points is not null)
  ),
  constraint commission_rules_scope_target check (
    case scope
      when 'platform' then category_id is null and seller_user_id is null and listing_type_code is null
      when 'category' then category_id is not null
      when 'seller' then seller_user_id is not null
      else listing_type_code is not null
    end
  ),
  constraint commission_rules_effective_order check (effective_to is null or effective_to > effective_from)
);
comment on table public.commission_rules is
  'Commission components. A percentage component carries its rate here; a fixed component carries one amount per currency in commission_rule_amounts (D27).';
create index commission_rules_lookup on public.commission_rules (scope, priority desc) where is_active;
create index commission_rules_seller on public.commission_rules (seller_user_id) where seller_user_id is not null;
create trigger commission_rules_set_updated_at before update on public.commission_rules
  for each row execute function app_private.tg_set_updated_at();
create trigger commission_rules_audit after insert or update or delete on public.commission_rules
  for each row execute function audit.tg_record_change();

create table public.commission_rule_amounts (
  commission_rule_id uuid not null references public.commission_rules (id) on delete cascade,
  currency_code char(3) not null references public.currencies (code) on delete restrict,
  amount_minor bigint not null,
  min_amount_minor bigint,
  max_amount_minor bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (commission_rule_id, currency_code),
  constraint commission_rule_amounts_amount_positive check (amount_minor >= 0),
  constraint commission_rule_amounts_bounds_positive check (
    (min_amount_minor is null or min_amount_minor >= 0)
    and (max_amount_minor is null or max_amount_minor >= 0)
  ),
  constraint commission_rule_amounts_bounds_order check (
    min_amount_minor is null or max_amount_minor is null or max_amount_minor >= min_amount_minor
  )
);
comment on table public.commission_rule_amounts is
  'One amount per currency for a commission component. A currency with no row here means the component is skipped for that checkout (D27).';
create trigger commission_rule_amounts_set_updated_at before update on public.commission_rule_amounts
  for each row execute function app_private.tg_set_updated_at();

-- A fixed component needs amounts; a percentage component must not carry any.
create or replace function app_private.tg_commission_rule_amounts_rule() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  kind text;
begin
  select r.component_type into kind from public.commission_rules r where r.id = new.commission_rule_id;
  if kind <> 'fixed' then
    raise exception 'only a fixed commission component carries per-currency amounts' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger commission_rule_amounts_rule before insert or update on public.commission_rule_amounts
  for each row execute function app_private.tg_commission_rule_amounts_rule();

select app_private.register_currency_dependency(
  'commission_rule_amounts.currency_code', 'public', 'commission_rule_amounts', 'currency_code',
  'commission amounts configured in the currency'
);

-- D27 ------------------------------------------------------------------------------------------------
create or replace function public.resolve_commission_components(
  p_currency_code char(3),
  p_category_id uuid default null,
  p_seller_user_id uuid default null,
  p_listing_type_code text default null,
  p_on date default null
)
returns table (
  commission_rule_id uuid,
  name text,
  scope text,
  component_type text,
  percentage_basis_points integer,
  amount_minor bigint,
  min_amount_minor bigint,
  max_amount_minor bigint,
  is_skipped boolean,
  skip_reason text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    r.id,
    r.name,
    r.scope,
    r.component_type,
    r.percentage_basis_points,
    a.amount_minor,
    a.min_amount_minor,
    a.max_amount_minor,
    r.component_type = 'fixed' and a.amount_minor is null as is_skipped,
    case when r.component_type = 'fixed' and a.amount_minor is null
         then format('no fixed amount configured for %s', p_currency_code)
    end
  from public.commission_rules r
  left join public.commission_rule_amounts a
    on a.commission_rule_id = r.id and a.currency_code = p_currency_code
  where r.is_active
    and r.effective_from <= coalesce(p_on, current_date)
    and (r.effective_to is null or r.effective_to > coalesce(p_on, current_date))
    and (
      r.scope = 'platform'
      or (r.scope = 'category' and r.category_id = p_category_id)
      or (r.scope = 'seller' and r.seller_user_id = p_seller_user_id)
      or (r.scope = 'listing_type' and r.listing_type_code = p_listing_type_code)
    )
  order by r.priority desc, r.scope, r.name;
$$;
comment on function public.resolve_commission_components(char, uuid, uuid, text, date) is
  'Every commission component that applies. A fixed component without an amount for the checkout currency comes back as skipped; the others still apply (D27).';

create or replace function public.record_commission_skip(
  p_commission_rule_id uuid,
  p_currency_code char(3),
  p_context jsonb default '{}'::jsonb
) returns bigint
language sql
security definer
set search_path = pg_catalog, public
as $$
  select public.record_audit_event(
    'commission.component_skipped',
    coalesce(p_context, '{}'::jsonb) || jsonb_build_object('commission_rule_id', p_commission_rule_id, 'currency_code', p_currency_code),
    'public', 'commission_rules', p_commission_rule_id::text
  );
$$;
comment on function public.record_commission_skip(uuid, char, jsonb) is
  'Writes the diagnostic entry D27 requires when a fixed component is skipped for lack of an amount in the checkout currency.';

-- ---------------------------------------------------------------------------------------------------
-- Cancellation policies
-- ---------------------------------------------------------------------------------------------------
create table public.cancellation_policies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  listing_type_code text references public.listing_types (code) on delete restrict,
  category_id uuid references public.categories (id) on delete restrict,
  buyer_window_hours integer not null,
  refund_percentage_basis_points integer not null,
  allows_seller_cancellation boolean not null default true,
  is_default boolean not null default false,
  priority integer not null default 0,
  effective_from date not null default current_date,
  effective_to date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cancellation_policies_name_length check (length(btrim(name)) between 1 and 120),
  constraint cancellation_policies_window_range check (buyer_window_hours between 0 and 8760),
  constraint cancellation_policies_refund_range check (refund_percentage_basis_points between 0 and 10000),
  constraint cancellation_policies_default_is_general check (not is_default or (listing_type_code is null and category_id is null)),
  constraint cancellation_policies_default_is_active check (not is_default or is_active),
  constraint cancellation_policies_effective_order check (effective_to is null or effective_to > effective_from)
);
comment on table public.cancellation_policies is
  'Configurable cancellation rules. An order snapshots the policy that applied when it was placed, so later edits never change a past order.';
create unique index cancellation_policies_one_default on public.cancellation_policies ((is_default)) where is_default;
create index cancellation_policies_lookup on public.cancellation_policies (listing_type_code, category_id, priority desc) where is_active;
create trigger cancellation_policies_set_updated_at before update on public.cancellation_policies
  for each row execute function app_private.tg_set_updated_at();
create trigger cancellation_policies_audit after insert or update or delete on public.cancellation_policies
  for each row execute function audit.tg_record_change();

create or replace function public.resolve_cancellation_policy(
  p_listing_type_code text default null,
  p_category_id uuid default null,
  p_on date default null
) returns public.cancellation_policies
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select c.*
    from public.cancellation_policies c
   where c.is_active
     and (c.listing_type_code is null or c.listing_type_code = p_listing_type_code)
     and (c.category_id is null or c.category_id = p_category_id)
     and c.effective_from <= coalesce(p_on, current_date)
     and (c.effective_to is null or c.effective_to > coalesce(p_on, current_date))
   order by
     (c.category_id is not null) desc,
     (c.listing_type_code is not null) desc,
     c.priority desc,
     c.is_default desc
   limit 1;
$$;
comment on function public.resolve_cancellation_policy(text, uuid, date) is
  'The cancellation policy that applies, most specific first, falling back to the default policy.';

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table public.tax_rules enable row level security;
alter table public.commission_rules enable row level security;
alter table public.commission_rule_amounts enable row level security;
alter table public.cancellation_policies enable row level security;

-- Buyers and sellers see the terms that govern them; only administrators change them.
create policy tax_rules_read on public.tax_rules for select to authenticated using (is_active);
create policy tax_rules_admin_write on public.tax_rules for all to authenticated
  using (public.has_permission('settings.tax.manage') and public.is_aal2())
  with check (public.has_permission('settings.tax.manage') and public.is_aal2());

create policy commission_rules_seller_read on public.commission_rules for select to authenticated
  using (is_active and (scope <> 'seller' or seller_user_id = public.current_user_id()));
create policy commission_rules_admin_write on public.commission_rules for all to authenticated
  using (public.has_permission('settings.commission.manage') and public.is_aal2())
  with check (public.has_permission('settings.commission.manage') and public.is_aal2());

create policy commission_rule_amounts_read on public.commission_rule_amounts for select to authenticated
  using (exists (
    select 1 from public.commission_rules r
    where r.id = commission_rule_id and r.is_active and (r.scope <> 'seller' or r.seller_user_id = public.current_user_id())
  ));
create policy commission_rule_amounts_admin_write on public.commission_rule_amounts for all to authenticated
  using (public.has_permission('settings.commission.manage') and public.is_aal2())
  with check (public.has_permission('settings.commission.manage') and public.is_aal2());

create policy cancellation_policies_read on public.cancellation_policies for select to authenticated using (is_active);
create policy cancellation_policies_admin_write on public.cancellation_policies for all to authenticated
  using (public.has_permission('settings.cancellation.manage') and public.is_aal2())
  with check (public.has_permission('settings.cancellation.manage') and public.is_aal2());

grant select, insert, update, delete on
  public.tax_rules, public.commission_rules, public.commission_rule_amounts, public.cancellation_policies
  to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function
  public.resolve_tax_rule(char, text, uuid, text, date),
  public.resolve_commission_components(char, uuid, uuid, text, date),
  public.resolve_cancellation_policy(text, uuid, date)
  to authenticated;

grant execute on function
  public.resolve_tax_rule(char, text, uuid, text, date),
  public.resolve_commission_components(char, uuid, uuid, text, date),
  public.resolve_cancellation_policy(text, uuid, date),
  public.record_commission_skip(uuid, char, jsonb)
  to app_system, app_worker;
