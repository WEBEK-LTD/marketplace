-- 0001 — Extensions, schemas and default privileges (v5.2 migration plan, Phase 2 Step 1).
--
-- Establishes the baseline every later migration depends on:
--   * the extensions listed in v5.2 (pgcrypto, citext, pg_trgm, unaccent, postgis, pg_cron, vault);
--   * the schemas `app_private` (server-only auth security state) and `audit` (append-only audit log);
--   * the privilege baseline: nothing is granted by default, `anon` reaches nothing at all.
--
-- Database roles (`app_api`, `app_system`, `app_worker`) are created in 0003, so schema grants for them
-- live there. This migration only touches the roles Supabase itself provides.
--
-- Fails closed: the migration aborts with an explicit message if the Supabase baseline (schemas, roles
-- and `auth.users`) is missing, rather than failing later with a confusing error.

-- ---------------------------------------------------------------------------------------------------
-- Preconditions
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  missing text[] := '{}';
begin
  if to_regnamespace('auth') is null then missing := missing || 'schema auth'; end if;
  if to_regnamespace('extensions') is null then missing := missing || 'schema extensions'; end if;
  if to_regclass('auth.users') is null then missing := missing || 'table auth.users'; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then missing := missing || 'role anon'; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then missing := missing || 'role authenticated'; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then missing := missing || 'role service_role'; end if;
  if array_length(missing, 1) is not null then
    raise exception 'This database is not a Supabase database: missing %', array_to_string(missing, ', ')
      using hint = 'Migrations 0001+ require the Supabase baseline (auth schema, auth.users and the anon/authenticated/service_role roles).';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------------------------------
-- Extensions live in `extensions` (the Supabase convention) except those that insist on their own schema.
create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;
create extension if not exists postgis with schema extensions;
-- pg_cron always installs into its own `cron` schema and only in the database named by cron.database_name.
create extension if not exists pg_cron;
-- Supabase Vault: payout destinations (0022) store provider credentials through it.
create extension if not exists supabase_vault with schema vault;

-- pg_graphql must never be enabled (v5.2 Supabase exposure: GraphQL off). Supabase stopped enabling it
-- by default on new projects in May 2026, but an image or an older project may still carry it, so this
-- migration removes it rather than refusing to run. A pgTAP guard asserts it stays absent.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_graphql') then
    execute 'drop extension pg_graphql cascade';
    raise notice 'dropped pg_graphql: the GraphQL API stays off (v5.2 Supabase exposure)';
  end if;
exception
  when insufficient_privilege then
    raise exception 'pg_graphql is enabled and could not be dropped; the GraphQL API must stay off (v5.2 Supabase exposure)';
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- Schemas
-- ---------------------------------------------------------------------------------------------------
create schema if not exists app_private;
comment on schema app_private is 'Server-only state (auth security state, SECURITY DEFINER helpers). Never reachable from a browser role.';

create schema if not exists audit;
comment on schema audit is 'Append-only audit log. Written through SECURITY DEFINER helpers only.';

-- ---------------------------------------------------------------------------------------------------
-- Privilege baseline
-- ---------------------------------------------------------------------------------------------------
-- Nothing is granted implicitly. `authenticated` keeps USAGE on `public` because every user request runs
-- as `authenticated` (SET LOCAL ROLE in withRlsContext) and needs to reach the tables it is granted
-- explicitly; it never reaches `app_private` or `audit`. `anon` reaches nothing: the Data API is off and
-- browsers never hold a database session.
revoke all on schema public from public;
revoke all on schema public from anon;
revoke all on schema app_private from public, anon, authenticated;
revoke all on schema audit from public, anon, authenticated;

grant usage on schema public to authenticated;
grant usage on schema extensions to authenticated;

-- New objects are never granted to the browser roles by default (belt and braces next to
-- `auth.auto_expose_new_tables = false` in supabase/config.toml).
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema app_private revoke all on tables from anon, authenticated;
alter default privileges in schema audit revoke all on tables from anon, authenticated;

-- PostgreSQL grants EXECUTE on new functions to PUBLIC. Every helper here is SECURITY DEFINER or reads
-- privileged state, so the default is removed and each function is granted explicitly.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema app_private revoke execute on functions from public;
alter default privileges in schema audit revoke execute on functions from public;

-- ---------------------------------------------------------------------------------------------------
-- Shared trigger helpers
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.tg_set_updated_at() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
comment on function app_private.tg_set_updated_at() is 'BEFORE UPDATE trigger: stamps updated_at with the transaction time.';

create or replace function app_private.tg_reject_write() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception '% on %.% is not allowed: this table is append-only',
    tg_op, tg_table_schema, tg_table_name
    using errcode = 'restrict_violation';
end;
$$;
comment on function app_private.tg_reject_write() is 'BEFORE UPDATE OR DELETE trigger: enforces append-only tables (financial and audit records).';

-- ---------------------------------------------------------------------------------------------------
-- Claims helpers
-- ---------------------------------------------------------------------------------------------------
-- The API sets `request.jwt.claims` transaction-locally after verifying the token (packages/db
-- withRlsContext). These helpers only read what is already there; they never verify anything.
create or replace function app_private.jwt_claims() returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;

create or replace function public.current_user_id() returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select nullif(app_private.jwt_claims() ->> 'sub', '')::uuid;
$$;
comment on function public.current_user_id() is 'The authenticated user id from the verified claims, or NULL for an anonymous request.';

revoke all on function public.current_user_id() from public;
