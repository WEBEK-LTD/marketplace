-- SANDBOX SUPPLEMENTAL BASELINE — NOT Supabase, NOT part of the product schema, NEVER a migration.
--
-- The migrations in supabase/migrations/ expect the baseline that the supabase/postgres image provides:
-- the `auth`, `extensions` and `vault` schemas, the `anon`/`authenticated`/`service_role` roles and the
-- `auth.users` table. A plain PostgreSQL server has none of them, so this file recreates just enough of
-- that surface for a sandbox syntax-and-semantics run.
--
-- What it recreates is deliberately minimal and is NOT equivalent to Supabase. Authoritative verification
-- is the CI `supabase-local` job, which runs the approved Supabase images.
--
-- This file is applied only by scripts/db/supplemental-schema.mjs and never by the Supabase CLI.

create schema if not exists extensions;
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists realtime;
create schema if not exists graphql_public;
create schema if not exists vault;

do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated', 'service_role', 'authenticator', 'supabase_auth_admin', 'supabase_storage_admin'] loop
    if not exists (select 1 from pg_roles where rolname = role_name) then
      execute format('create role %I nologin noinherit', role_name);
    end if;
  end loop;
end;
$$;

grant usage on schema public to anon, authenticated, service_role;

-- Supabase databases ship with `extensions` on the search path; pgTAP and the extensions installed by
-- migration 0001 are resolved through it.
do $$
begin
  execute format('alter database %I set search_path to "$user", public, extensions', current_database());
end;
$$;

-- Minimal stand-in for the GoTrue identity table. Only the columns the migrations read are present.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  phone text unique,
  email_confirmed_at timestamptz,
  phone_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub', '')::uuid;
$$;

create or replace function auth.role() returns text
language sql stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role';
$$;

create or replace function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;
