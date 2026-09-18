-- pgTAP — structural guards that must hold for every migration, present and future.
-- These are the assertions migration 0031 will enforce at deploy time; running them here catches a
-- missing RLS statement or a stray grant in the pull request that introduces it.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(8);

-- Every table, including partitions, has row level security -------------------------------------------
select is(
  (select coalesce(string_agg(format('%s.%s', n.nspname, c.relname), ', ' order by n.nspname, c.relname), '')
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p')
      and n.nspname in ('public', 'app_private', 'audit')
      and not c.relrowsecurity),
  '',
  'every table in public, app_private and audit has row level security enabled'
);

-- Anything reachable by `authenticated` must be governed by at least one policy ------------------------
select is(
  (select coalesce(string_agg(format('%s.%s', c.relnamespace::regnamespace, c.relname), ', '), '')
     from pg_class c
    where c.relkind in ('r', 'p')
      and c.relnamespace::regnamespace::text in ('public', 'app_private', 'audit')
      and exists (
        select 1 from information_schema.role_table_grants g
         where g.grantee = 'authenticated'
           and g.table_schema = c.relnamespace::regnamespace::text
           and g.table_name = c.relname
      )
      and not exists (select 1 from pg_policy p where p.polrelid = c.oid)),
  '',
  'every table granted to authenticated has at least one policy'
);

-- anon reaches nothing --------------------------------------------------------------------------------
select is(
  (select count(*) from information_schema.role_table_grants
    where grantee = 'anon' and table_schema in ('public', 'app_private', 'audit')),
  0::bigint,
  'anon holds no table privileges in any application schema'
);
select ok(
  not has_schema_privilege('anon', 'public', 'usage')
    and not has_schema_privilege('anon', 'app_private', 'usage')
    and not has_schema_privilege('anon', 'audit', 'usage'),
  'anon cannot use any application schema'
);

-- app_private stays server-only -----------------------------------------------------------------------
select is(
  (select count(*) from information_schema.role_table_grants
    where grantee = 'authenticated' and table_schema = 'app_private'),
  0::bigint,
  'authenticated holds no privileges in app_private'
);

-- Function hygiene ------------------------------------------------------------------------------------
select is(
  (select coalesce(string_agg(format('%s.%s', n.nspname, p.proname), ', ' order by n.nspname, p.proname), '')
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app_private', 'audit')
      and has_function_privilege('public', p.oid, 'execute')),
  '',
  'no application function is executable by PUBLIC'
);
select is(
  (select coalesce(string_agg(format('%s.%s', n.nspname, p.proname), ', ' order by n.nspname, p.proname), '')
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app_private', 'audit')
      and p.prosecdef
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) as cfg where cfg like 'search_path=%')),
  '',
  'every SECURITY DEFINER function pins its search_path'
);

-- The GraphQL API stays off ---------------------------------------------------------------------------
select is(
  (select count(*) from pg_extension where extname = 'pg_graphql'),
  0::bigint,
  'pg_graphql is not installed'
);

select * from finish();
rollback;
