-- 0002 — Locales, countries, currencies, currency translations and listing types (v5.2 migration plan).
--
-- Reference data every other module depends on. Currency rules implemented here:
--   * D14/money: integer minor units everywhere, so a currency carries its own decimal places;
--   * D16: decimal places lock once a currency has been enabled; a currency in use cannot be disabled;
--     used currencies retire, they are never deleted;
--   * exactly one default currency and exactly one default locale;
--   * a currency is payable only when it is checkout-enabled AND a provider supports it — the provider
--     half arrives with the Payments module (0019), so only the checkout flag lives here.
--
-- No rows are inserted here: all seed data belongs to migration 0033 (v5.2 "Seed (0033)").
--
-- RLS is enabled on every table. Read policies live here; administrative write policies need
-- `has_permission`/`is_aal2`, which are created in 0003, so they are added there.

-- ---------------------------------------------------------------------------------------------------
-- Locales
-- ---------------------------------------------------------------------------------------------------
create table public.locales (
  code text primary key,
  name_en text not null,
  name_native text not null,
  direction text not null,
  digit_style text not null default 'western',
  is_active boolean not null default false,
  is_default boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint locales_code_format check (code ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  constraint locales_direction_allowed check (direction in ('ltr', 'rtl')),
  constraint locales_digit_style_allowed check (digit_style in ('western', 'arabic_indic')),
  constraint locales_default_is_active check (not is_default or is_active),
  constraint locales_names_present check (length(btrim(name_en)) > 0 and length(btrim(name_native)) > 0)
);
comment on table public.locales is 'Interface locales (D6, D15). `digit_style` is presentation only.';
create unique index locales_one_default on public.locales ((is_default)) where is_default;
create index locales_active_order on public.locales (sort_order, code) where is_active;
create trigger locales_set_updated_at before update on public.locales
  for each row execute function app_private.tg_set_updated_at();

-- ---------------------------------------------------------------------------------------------------
-- Currencies
-- ---------------------------------------------------------------------------------------------------
create table public.currencies (
  code char(3) primary key,
  numeric_code char(3) not null,
  symbol text not null,
  decimal_places smallint not null,
  is_enabled boolean not null default false,
  is_default boolean not null default false,
  is_pricing_enabled boolean not null default false,
  is_checkout_enabled boolean not null default false,
  first_enabled_at timestamptz,
  retired_at timestamptz,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint currencies_code_format check (code ~ '^[A-Z]{3}$'),
  constraint currencies_numeric_code_format check (numeric_code ~ '^[0-9]{3}$'),
  constraint currencies_decimal_places_range check (decimal_places between 0 and 4),
  constraint currencies_symbol_present check (length(btrim(symbol)) > 0),
  constraint currencies_default_is_enabled check (not is_default or is_enabled),
  constraint currencies_default_prices check (not is_default or (is_pricing_enabled and is_checkout_enabled)),
  constraint currencies_flags_need_enabled check (is_enabled or not (is_pricing_enabled or is_checkout_enabled)),
  constraint currencies_retired_not_enabled check (retired_at is null or not is_enabled),
  constraint currencies_retired_was_used check (retired_at is null or first_enabled_at is not null)
);
comment on table public.currencies is
  'Enabled currencies (D14, D16). Amounts are stored as integer minor units; `decimal_places` is the scale and locks once the currency has been enabled.';
create unique index currencies_one_default on public.currencies ((is_default)) where is_default;
create unique index currencies_numeric_code on public.currencies (numeric_code);
create trigger currencies_set_updated_at before update on public.currencies
  for each row execute function app_private.tg_set_updated_at();

create table public.currency_translations (
  currency_code char(3) not null references public.currencies (code) on delete cascade,
  locale_code text not null references public.locales (code) on delete cascade,
  name text not null,
  symbol_override text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (currency_code, locale_code),
  constraint currency_translations_name_present check (length(btrim(name)) > 0)
);
create trigger currency_translations_set_updated_at before update on public.currency_translations
  for each row execute function app_private.tg_set_updated_at();

-- ---------------------------------------------------------------------------------------------------
-- Currency dependency registry (D16)
-- ---------------------------------------------------------------------------------------------------
-- A currency may not be disabled while anything still depends on it. Every later migration that adds a
-- table carrying a `currency_code` registers it here, so the blocker check never needs to be rewritten
-- and can never silently fall behind the schema.
create table app_private.currency_dependencies (
  dependency_key text primary key,
  table_schema name not null,
  table_name name not null,
  column_name name not null,
  condition_sql text not null default 'true',
  description text not null,
  registered_at timestamptz not null default now(),
  constraint currency_dependencies_description_present check (length(btrim(description)) > 0)
);
comment on table app_private.currency_dependencies is
  'Tables that block disabling a currency (D16). Each row is registered by the migration that creates the table.';

create or replace function app_private.register_currency_dependency(
  p_key text,
  p_schema name,
  p_table name,
  p_column name,
  p_description text,
  p_condition_sql text default 'true'
) returns void
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if to_regclass(format('%I.%I', p_schema, p_table)) is null then
    raise exception 'cannot register currency dependency %: %.% does not exist', p_key, p_schema, p_table;
  end if;
  insert into app_private.currency_dependencies (dependency_key, table_schema, table_name, column_name, condition_sql, description)
  values (p_key, p_schema, p_table, p_column, p_condition_sql, p_description)
  on conflict (dependency_key) do update
    set table_schema = excluded.table_schema,
        table_name = excluded.table_name,
        column_name = excluded.column_name,
        condition_sql = excluded.condition_sql,
        description = excluded.description;
end;
$$;

create or replace function public.currency_blockers(p_code char(3))
returns table (dependency_key text, description text, row_count bigint)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  dep record;
  found_rows bigint;
begin
  for dep in select * from app_private.currency_dependencies order by dependency_key loop
    execute format(
      'select count(*) from %I.%I where %I = $1 and (%s)',
      dep.table_schema, dep.table_name, dep.column_name, dep.condition_sql
    ) into found_rows using p_code;
    if found_rows > 0 then
      dependency_key := dep.dependency_key;
      description := dep.description;
      row_count := found_rows;
      return next;
    end if;
  end loop;
end;
$$;
comment on function public.currency_blockers(char) is
  'Everything that currently blocks disabling or retiring a currency (D16). Empty means the currency can be disabled.';
revoke all on function public.currency_blockers(char) from public;

-- ---------------------------------------------------------------------------------------------------
-- Currency immutability and retirement (D16)
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.tg_currencies_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  blockers text;
begin
  if tg_op = 'DELETE' then
    if old.first_enabled_at is not null then
      raise exception 'currency % has been in use and cannot be deleted; retire it instead', old.code
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if new.code <> old.code then
      raise exception 'currency code is immutable' using errcode = 'restrict_violation';
    end if;
    if new.numeric_code <> old.numeric_code then
      raise exception 'currency numeric code is immutable' using errcode = 'restrict_violation';
    end if;
    if new.decimal_places <> old.decimal_places and old.first_enabled_at is not null then
      raise exception 'decimal places of currency % are locked: the currency has been enabled', old.code
        using errcode = 'restrict_violation';
    end if;
    if new.first_enabled_at is distinct from old.first_enabled_at and old.first_enabled_at is not null then
      raise exception 'first_enabled_at of currency % is immutable', old.code using errcode = 'restrict_violation';
    end if;
    if old.is_default and not new.is_default then
      raise exception 'the default currency cannot be unset directly; make another currency the default first'
        using errcode = 'restrict_violation';
    end if;
    if old.is_enabled and not new.is_enabled then
      select string_agg(format('%s (%s rows)', b.description, b.row_count), '; ' order by b.dependency_key)
        into blockers
        from public.currency_blockers(old.code) as b;
      if blockers is not null then
        raise exception 'currency % cannot be disabled: %', old.code, blockers using errcode = 'restrict_violation';
      end if;
    end if;
  end if;

  if new.is_enabled and new.first_enabled_at is null then
    new.first_enabled_at := now();
  end if;
  if not new.is_enabled and new.first_enabled_at is not null and new.retired_at is null then
    new.retired_at := now();
  end if;
  if new.is_enabled then
    new.retired_at := null;
  end if;
  return new;
end;
$$;

create trigger currencies_guard before insert or update or delete on public.currencies
  for each row execute function app_private.tg_currencies_guard();

-- ---------------------------------------------------------------------------------------------------
-- Countries
-- ---------------------------------------------------------------------------------------------------
create table public.countries (
  code char(2) primary key,
  iso3 char(3) not null,
  numeric_code char(3) not null,
  name_en text not null,
  name_ar text not null,
  phone_code text not null,
  default_currency_code char(3) references public.currencies (code),
  is_marketplace_enabled boolean not null default false,
  is_phone_allowed boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint countries_code_format check (code ~ '^[A-Z]{2}$'),
  constraint countries_iso3_format check (iso3 ~ '^[A-Z]{3}$'),
  constraint countries_numeric_code_format check (numeric_code ~ '^[0-9]{3}$'),
  constraint countries_phone_code_format check (phone_code ~ '^[0-9]{1,4}$'),
  constraint countries_enabled_needs_currency check (not is_marketplace_enabled or default_currency_code is not null),
  constraint countries_names_present check (length(btrim(name_en)) > 0 and length(btrim(name_ar)) > 0)
);
comment on table public.countries is
  'Countries (D17). `is_marketplace_enabled` means sellers and shipping addresses are allowed; `is_phone_allowed` governs buyer phone numbers only.';
create unique index countries_iso3 on public.countries (iso3);
create unique index countries_numeric_code on public.countries (numeric_code);
create index countries_marketplace_order on public.countries (sort_order, code) where is_marketplace_enabled;
create trigger countries_set_updated_at before update on public.countries
  for each row execute function app_private.tg_set_updated_at();

select app_private.register_currency_dependency(
  'countries.default_currency_code', 'public', 'countries', 'default_currency_code',
  'countries using the currency as their default'
);

-- ---------------------------------------------------------------------------------------------------
-- Listing types
-- ---------------------------------------------------------------------------------------------------
create table public.listing_types (
  code text primary key,
  name_en text not null,
  name_ar text not null,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint listing_types_code_format check (code ~ '^[a-z][a-z0-9_]*$'),
  constraint listing_types_names_present check (length(btrim(name_en)) > 0 and length(btrim(name_ar)) > 0)
);
comment on table public.listing_types is 'Kinds of listing the marketplace sells (products and services in V1). Rows are seeded in 0033.';
create trigger listing_types_set_updated_at before update on public.listing_types
  for each row execute function app_private.tg_set_updated_at();

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
-- Reference data is world-readable inside the application (it drives every price, address and menu).
-- Writes are administrative and are opened in 0003, once the permission helpers exist.
alter table public.locales enable row level security;
alter table public.currencies enable row level security;
alter table public.currency_translations enable row level security;
alter table public.countries enable row level security;
alter table public.listing_types enable row level security;

-- `app_private` is never reachable by an application role; RLS is still enabled so the 0031 guard
-- migration ("fails if any table lacks RLS") holds for every table in every schema.
alter table app_private.currency_dependencies enable row level security;

create policy locales_read on public.locales for select to authenticated using (is_active);
create policy currencies_read on public.currencies for select to authenticated using (is_enabled);
create policy currency_translations_read on public.currency_translations for select to authenticated
  using (exists (select 1 from public.currencies c where c.code = currency_code and c.is_enabled));
create policy countries_read on public.countries for select to authenticated using (true);
create policy listing_types_read on public.listing_types for select to authenticated using (is_active);

grant select on public.locales, public.currencies, public.currency_translations, public.countries, public.listing_types to authenticated;
