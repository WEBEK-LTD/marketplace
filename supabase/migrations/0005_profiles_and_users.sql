-- 0005 — Profiles, user settings, addresses and blocks (v5.2 migration plan).
--
-- `auth.users` stays the identity record; `public.profiles` is the application's view of a person and is
-- created automatically when a user is created. Deleting the auth user cascades everywhere.
--
-- D17 is enforced here: a buyer may use any supported phone country code, but an address used for
-- shipping must sit in a marketplace-enabled country. A CHECK constraint cannot read another table, so
-- the rule is a trigger.

-- ---------------------------------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  full_name text,
  phone_e164 text,
  locale_code text references public.locales (code) on delete set null,
  timezone text not null default 'UTC',
  avatar_object_path text,
  status text not null default 'active',
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint profiles_status_allowed check (status in ('active', 'suspended', 'deleted')),
  constraint profiles_display_name_length check (display_name is null or length(display_name) between 1 and 80),
  constraint profiles_full_name_length check (full_name is null or length(full_name) between 1 and 160),
  constraint profiles_phone_format check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  constraint profiles_deleted_status check ((deleted_at is null) = (status <> 'deleted'))
);
comment on table public.profiles is 'Application profile for an auth user. Created by the auth.users sync trigger.';
create index profiles_status on public.profiles (status) where deleted_at is null;
create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function app_private.tg_set_updated_at();

-- Sync from auth.users -------------------------------------------------------------------------------
create or replace function app_private.tg_sync_profile_from_auth() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.profiles (id, display_name, full_name, phone_e164, email_verified_at, phone_verified_at)
    values (
      new.id,
      nullif(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), ''),
      nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''),
      nullif(btrim(coalesce(new.phone, '')), ''),
      new.email_confirmed_at,
      new.phone_confirmed_at
    )
    on conflict (id) do nothing;
    insert into public.user_settings (user_id) values (new.id) on conflict (user_id) do nothing;
    return new;
  end if;

  update public.profiles p
     set phone_e164 = nullif(btrim(coalesce(new.phone, '')), ''),
         email_verified_at = new.email_confirmed_at,
         phone_verified_at = new.phone_confirmed_at
   where p.id = new.id
     and (p.phone_e164 is distinct from nullif(btrim(coalesce(new.phone, '')), '')
       or p.email_verified_at is distinct from new.email_confirmed_at
       or p.phone_verified_at is distinct from new.phone_confirmed_at);
  return new;
end;
$$;
comment on function app_private.tg_sync_profile_from_auth() is
  'Keeps public.profiles in step with auth.users. Never writes back into auth.';

-- ---------------------------------------------------------------------------------------------------
-- User settings
-- ---------------------------------------------------------------------------------------------------
create table public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  notify_email boolean not null default true,
  notify_sms boolean not null default false,
  notify_whatsapp boolean not null default false,
  notify_in_app boolean not null default true,
  marketing_opt_in boolean not null default false,
  digit_style text,
  preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_settings_digit_style_allowed check (digit_style is null or digit_style in ('western', 'arabic_indic')),
  constraint user_settings_preferences_is_object check (jsonb_typeof(preferences) = 'object')
);
comment on table public.user_settings is 'Per-user preferences. `digit_style` overrides the locale default (D15); NULL means follow the locale.';
create trigger user_settings_set_updated_at before update on public.user_settings
  for each row execute function app_private.tg_set_updated_at();

-- The profile trigger inserts into user_settings, so it is attached only now that the table exists.
-- Attaching a trigger to auth.users needs ownership of that table; if the migration role has lost it,
-- say so plainly instead of failing with "must be owner of relation users".
do $$
begin
  execute 'drop trigger if exists on_auth_user_created on auth.users';
  execute 'create trigger on_auth_user_created after insert on auth.users
             for each row execute function app_private.tg_sync_profile_from_auth()';
  execute 'drop trigger if exists on_auth_user_updated on auth.users';
  execute 'create trigger on_auth_user_updated after update on auth.users
             for each row execute function app_private.tg_sync_profile_from_auth()';
exception
  when insufficient_privilege then
    raise exception 'cannot attach the profile sync triggers to auth.users'
      using hint = 'The migration role must own auth.users (or be a member of its owner) so that creating a profile for every auth user stays automatic.';
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- Addresses
-- ---------------------------------------------------------------------------------------------------
create table public.addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  label text,
  purpose text not null default 'both',
  recipient_name text not null,
  phone_e164 text not null,
  country_code char(2) not null references public.countries (code) on delete restrict,
  governorate text not null,
  city text not null,
  district text,
  street_address text not null,
  building text,
  apartment text,
  postal_code text,
  landmark text,
  location extensions.geography(Point, 4326),
  is_default_shipping boolean not null default false,
  is_default_billing boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint addresses_purpose_allowed check (purpose in ('shipping', 'billing', 'both')),
  constraint addresses_recipient_present check (length(btrim(recipient_name)) between 1 and 160),
  constraint addresses_phone_format check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  constraint addresses_required_parts check (
    length(btrim(governorate)) > 0 and length(btrim(city)) > 0 and length(btrim(street_address)) > 0
  ),
  constraint addresses_default_shipping_purpose check (not is_default_shipping or purpose in ('shipping', 'both')),
  constraint addresses_default_billing_purpose check (not is_default_billing or purpose in ('billing', 'both')),
  constraint addresses_defaults_not_deleted check (deleted_at is null or not (is_default_shipping or is_default_billing))
);
comment on table public.addresses is 'Buyer and seller addresses. Shipping addresses must be in a marketplace-enabled country (D17).';
create index addresses_user on public.addresses (user_id) where deleted_at is null;
create unique index addresses_one_default_shipping on public.addresses (user_id) where is_default_shipping;
create unique index addresses_one_default_billing on public.addresses (user_id) where is_default_billing;
create index addresses_location on public.addresses using gist (location) where deleted_at is null;
create trigger addresses_set_updated_at before update on public.addresses
  for each row execute function app_private.tg_set_updated_at();

create or replace function app_private.tg_addresses_country_rule() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  enabled boolean;
begin
  if new.purpose in ('shipping', 'both') and new.deleted_at is null then
    select c.is_marketplace_enabled into enabled from public.countries c where c.code = new.country_code;
    if not coalesce(enabled, false) then
      raise exception 'country % is not enabled for shipping', new.country_code
        using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger addresses_country_rule before insert or update on public.addresses
  for each row execute function app_private.tg_addresses_country_rule();

-- ---------------------------------------------------------------------------------------------------
-- User blocks
-- ---------------------------------------------------------------------------------------------------
create table public.user_blocks (
  blocker_id uuid not null references auth.users (id) on delete cascade,
  blocked_id uuid not null references auth.users (id) on delete cascade,
  reason text,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint user_blocks_not_self check (blocker_id <> blocked_id),
  constraint user_blocks_reason_length check (reason is null or length(reason) <= 500)
);
comment on table public.user_blocks is 'One user blocking another. Messaging and offers consult this table.';
create index user_blocks_by_blocked on public.user_blocks (blocked_id, blocker_id);

create or replace function public.is_blocked_between(p_a uuid, p_b uuid) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.user_blocks b
    where (b.blocker_id = p_a and b.blocked_id = p_b)
       or (b.blocker_id = p_b and b.blocked_id = p_a)
  );
$$;
comment on function public.is_blocked_between(uuid, uuid) is 'True when either user has blocked the other.';

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.user_settings enable row level security;
alter table public.addresses enable row level security;
alter table public.user_blocks enable row level security;

-- A profile is the public face of a seller or a message participant, so an active profile is readable by
-- any signed-in user; suspended and deleted profiles are not.
create policy profiles_public_read on public.profiles for select to authenticated
  using (status = 'active' and deleted_at is null);
create policy profiles_self_read on public.profiles for select to authenticated
  using (id = public.current_user_id());
create policy profiles_admin_read on public.profiles for select to authenticated
  using (public.has_permission('users.profile.read'));
create policy profiles_self_update on public.profiles for update to authenticated
  using (id = public.current_user_id() and deleted_at is null)
  with check (id = public.current_user_id());

create policy user_settings_self_all on public.user_settings for all to authenticated
  using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id());

create policy addresses_self_all on public.addresses for all to authenticated
  using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id());

create policy user_blocks_self_all on public.user_blocks for all to authenticated
  using (blocker_id = public.current_user_id())
  with check (blocker_id = public.current_user_id());

grant select, update on public.profiles to authenticated;
grant select, insert, update on public.user_settings to authenticated;
grant select, insert, update, delete on public.addresses to authenticated;
grant select, insert, delete on public.user_blocks to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function public.is_blocked_between(uuid, uuid) to authenticated;
