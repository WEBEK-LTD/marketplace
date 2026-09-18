-- 0003 — Application roles, permissions, database roles and authorization helpers (v5.2 migration plan).
--
-- Three layers meet here:
--   1. Product roles and permissions (`roles`, `permissions`, `role_permissions`, `user_roles`).
--      Privileged roles (Moderator, Support Agent, Admin, Super Admin) carry `requires_mfa`; a role that
--      requires MFA grants nothing until the session reaches `aal2`, which matches "role inactive until
--      TOTP enrolled" and "nothing privileged at aal1" in the authorization matrix.
--   2. Database roles `app_api`, `app_system`, `app_worker` (v5.2 "Database roles", owner decision S8).
--      `app_api` is a NOINHERIT member of `authenticated` and can only reach data after
--      `SET LOCAL ROLE authenticated`, which is what packages/db withRlsContext does. `app_system` and
--      `app_worker` hold no table privileges at all: they act through named SECURITY DEFINER functions.
--      None of the three is given a password here — passwords are set per environment, never in a migration.
--   3. The authorization helpers policies use: `has_permission`, `has_role`, `is_aal2`,
--      `is_verified_seller`, and the minimal Supabase access-token hook.
--
-- `is_verified_seller()` returns false until migration 0009 creates `seller_verifications` and replaces
-- it with the real lookup. A stub that denies is the only safe placeholder.
--
-- The access-token hook is created but NOT wired into supabase/config.toml: enabling it belongs to Phase 3
-- (Authentication), together with owner Decision 1 and the AUTH-10 spike.

-- ---------------------------------------------------------------------------------------------------
-- Product roles and permissions
-- ---------------------------------------------------------------------------------------------------
create table public.roles (
  key text primary key,
  name_en text not null,
  name_ar text not null,
  description_en text,
  description_ar text,
  requires_mfa boolean not null default false,
  is_admin_console boolean not null default false,
  is_assignable boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint roles_key_format check (key ~ '^[a-z][a-z0-9_]*$'),
  constraint roles_names_present check (length(btrim(name_en)) > 0 and length(btrim(name_ar)) > 0),
  constraint roles_console_requires_mfa check (not is_admin_console or requires_mfa)
);
comment on table public.roles is 'Product roles (authorization matrix). Rows are seeded in 0033.';
create trigger roles_set_updated_at before update on public.roles
  for each row execute function app_private.tg_set_updated_at();

create table public.permissions (
  key text primary key,
  module text not null,
  description_en text not null,
  description_ar text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint permissions_key_format check (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  constraint permissions_module_format check (module ~ '^[a-z][a-z0-9_]*$'),
  constraint permissions_descriptions_present check (length(btrim(description_en)) > 0 and length(btrim(description_ar)) > 0)
);
comment on table public.permissions is 'Permission keys, in `module.subject.action` form. Rows are seeded in 0033.';
create index permissions_module on public.permissions (module, key);
create trigger permissions_set_updated_at before update on public.permissions
  for each row execute function app_private.tg_set_updated_at();

create table public.role_permissions (
  role_key text not null references public.roles (key) on delete cascade,
  permission_key text not null references public.permissions (key) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (role_key, permission_key)
);
create index role_permissions_by_permission on public.role_permissions (permission_key, role_key);

create table public.user_roles (
  user_id uuid not null references auth.users (id) on delete cascade,
  role_key text not null references public.roles (key) on delete restrict,
  granted_by uuid references auth.users (id) on delete set null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, role_key),
  constraint user_roles_revoked_has_time check ((revoked_by is null) or (revoked_at is not null)),
  constraint user_roles_expiry_after_grant check (expires_at is null or expires_at > granted_at)
);
comment on table public.user_roles is 'Role assignments. A row is effective while revoked_at is null and expires_at has not passed.';
create index user_roles_active on public.user_roles (role_key, user_id) where revoked_at is null;
create trigger user_roles_set_updated_at before update on public.user_roles
  for each row execute function app_private.tg_set_updated_at();

-- ---------------------------------------------------------------------------------------------------
-- Database roles
-- ---------------------------------------------------------------------------------------------------
-- Roles are cluster-wide, so creation is guarded: `supabase db reset` recreates the database, not the roles.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_api') then
    create role app_api login noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_system') then
    create role app_system login noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_worker') then
    create role app_worker login noinherit;
  end if;
end;
$$;

alter role app_api with login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
alter role app_system with login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
alter role app_worker with login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;

comment on role app_api is 'API login role. Holds no privileges of its own; every request runs as authenticated inside one transaction.';
comment on role app_system is 'System login role. Acts only through named SECURITY DEFINER functions that record a system actor.';
comment on role app_worker is 'Worker login role. Same pattern as app_system.';

-- S8: membership without inheritance, so reaching data always requires an explicit SET ROLE.
grant authenticated to app_api with inherit false, set true;

-- The system roles never hold table privileges; they need schema usage to reach the functions they are
-- granted explicitly, one function at a time, by the migration that creates it.
grant usage on schema public to app_system, app_worker;
grant usage on schema app_private to app_system, app_worker;
grant usage on schema audit to app_system, app_worker;

-- ---------------------------------------------------------------------------------------------------
-- Authorization helpers
-- ---------------------------------------------------------------------------------------------------
-- SECURITY DEFINER so that `authenticated` needs neither USAGE on app_private nor EXECUTE on the claims
-- reader; `current_setting` is session state, so running as the owner changes nothing it can observe.
create or replace function public.is_aal2() returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(app_private.jwt_claims() ->> 'aal', '') = 'aal2';
$$;
comment on function public.is_aal2() is 'True when the verified claims report an aal2 session.';

create or replace function public.has_role(p_key text) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.key = ur.role_key
    where ur.user_id = public.current_user_id()
      and ur.role_key = p_key
      and ur.revoked_at is null
      and (ur.expires_at is null or ur.expires_at > now())
      and (not r.requires_mfa or public.is_aal2())
  );
$$;
comment on function public.has_role(text) is
  'True when the current user holds the role. A role marked requires_mfa counts only in an aal2 session.';

create or replace function public.has_permission(p_key text) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.key = ur.role_key
    join public.role_permissions rp on rp.role_key = ur.role_key
    where ur.user_id = public.current_user_id()
      and rp.permission_key = p_key
      and ur.revoked_at is null
      and (ur.expires_at is null or ur.expires_at > now())
      and (not r.requires_mfa or public.is_aal2())
  );
$$;
comment on function public.has_permission(text) is
  'True when one of the current user''s effective roles carries the permission. Privileged roles need aal2.';

create or replace function public.is_verified_seller() returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  -- Replaced by migration 0009, which introduces seller_verifications. Denying is the safe placeholder.
  select false;
$$;
comment on function public.is_verified_seller() is
  'Placeholder until 0009 (Verification) replaces it with the seller_verifications lookup; returns false.';

-- ---------------------------------------------------------------------------------------------------
-- Access-token hook (created, not yet enabled)
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.custom_access_token_hook(event jsonb) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  claims jsonb;
  role_keys text[];
begin
  select coalesce(array_agg(ur.role_key order by ur.role_key), '{}'::text[])
    into role_keys
    from public.user_roles ur
    where ur.user_id = (event ->> 'user_id')::uuid
      and ur.revoked_at is null
      and (ur.expires_at is null or ur.expires_at > now());

  claims := coalesce(event -> 'claims', '{}'::jsonb);
  claims := jsonb_set(claims, '{app_roles}', to_jsonb(role_keys), true);
  return jsonb_set(event, '{claims}', claims, true);
end;
$$;
comment on function app_private.custom_access_token_hook(jsonb) is
  'Minimal Supabase access-token hook: adds the user''s effective role keys as `app_roles`. Wiring it into config.toml is a Phase 3 step.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    execute 'grant usage on schema app_private to supabase_auth_admin';
    execute 'grant execute on function app_private.custom_access_token_hook(jsonb) to supabase_auth_admin';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- Row level security for the authorization tables
-- ---------------------------------------------------------------------------------------------------
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.user_roles enable row level security;

create policy roles_admin_read on public.roles for select to authenticated
  using (public.has_permission('users.role.read'));
create policy permissions_admin_read on public.permissions for select to authenticated
  using (public.has_permission('users.role.read'));
create policy role_permissions_admin_read on public.role_permissions for select to authenticated
  using (public.has_permission('users.role.read'));

create policy user_roles_self_read on public.user_roles for select to authenticated
  using (user_id = public.current_user_id());
create policy user_roles_admin_read on public.user_roles for select to authenticated
  using (public.has_permission('users.role.read'));
create policy user_roles_admin_insert on public.user_roles for insert to authenticated
  with check (public.has_permission('users.role.manage') and public.is_aal2());
create policy user_roles_admin_update on public.user_roles for update to authenticated
  using (public.has_permission('users.role.manage') and public.is_aal2())
  with check (public.has_permission('users.role.manage') and public.is_aal2());

grant select on public.roles, public.permissions, public.role_permissions to authenticated;
grant select, insert, update on public.user_roles to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Administrative policies for the reference data created in 0002
-- ---------------------------------------------------------------------------------------------------
create policy locales_admin_read on public.locales for select to authenticated
  using (public.has_permission('settings.locale.manage'));
create policy locales_admin_insert on public.locales for insert to authenticated
  with check (public.has_permission('settings.locale.manage') and public.is_aal2());
create policy locales_admin_update on public.locales for update to authenticated
  using (public.has_permission('settings.locale.manage') and public.is_aal2())
  with check (public.has_permission('settings.locale.manage') and public.is_aal2());

create policy currencies_admin_read on public.currencies for select to authenticated
  using (public.has_permission('settings.currency.manage'));
create policy currencies_admin_insert on public.currencies for insert to authenticated
  with check (public.has_permission('settings.currency.manage') and public.is_aal2());
create policy currencies_admin_update on public.currencies for update to authenticated
  using (public.has_permission('settings.currency.manage') and public.is_aal2())
  with check (public.has_permission('settings.currency.manage') and public.is_aal2());

create policy currency_translations_admin_all on public.currency_translations for all to authenticated
  using (public.has_permission('settings.currency.manage') and public.is_aal2())
  with check (public.has_permission('settings.currency.manage') and public.is_aal2());

create policy countries_admin_insert on public.countries for insert to authenticated
  with check (public.has_permission('settings.country.manage') and public.is_aal2());
create policy countries_admin_update on public.countries for update to authenticated
  using (public.has_permission('settings.country.manage') and public.is_aal2())
  with check (public.has_permission('settings.country.manage') and public.is_aal2());

create policy listing_types_admin_read on public.listing_types for select to authenticated
  using (public.has_permission('settings.listing_type.manage'));
create policy listing_types_admin_insert on public.listing_types for insert to authenticated
  with check (public.has_permission('settings.listing_type.manage') and public.is_aal2());
create policy listing_types_admin_update on public.listing_types for update to authenticated
  using (public.has_permission('settings.listing_type.manage') and public.is_aal2())
  with check (public.has_permission('settings.listing_type.manage') and public.is_aal2());

grant insert, update on public.locales, public.currencies, public.countries, public.listing_types to authenticated;
grant insert, update, delete on public.currency_translations to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function
  public.current_user_id(),
  public.is_aal2(),
  public.has_role(text),
  public.has_permission(text),
  public.is_verified_seller()
  to authenticated;

-- The currency guard trigger calls this from an ordinary (SECURITY INVOKER) trigger function, so the
-- role performing the update needs EXECUTE on it; the administrative UI reads it directly as well.
grant execute on function public.currency_blockers(char) to authenticated;
