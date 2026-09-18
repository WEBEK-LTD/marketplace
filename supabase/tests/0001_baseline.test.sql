-- pgTAP — migration 0001: extensions, schemas and the privilege baseline.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(14);

select ok((select count(*) = 1 from pg_extension where extname = 'pgcrypto'), 'pgcrypto is installed');
select ok((select count(*) = 1 from pg_extension where extname = 'citext'), 'citext is installed');
select ok((select count(*) = 1 from pg_extension where extname = 'pg_trgm'), 'pg_trgm is installed');
select ok((select count(*) = 1 from pg_extension where extname = 'unaccent'), 'unaccent is installed');
select ok((select count(*) = 1 from pg_extension where extname = 'postgis'), 'postgis is installed');
select ok((select count(*) = 1 from pg_extension where extname = 'pg_cron'), 'pg_cron is installed');
select ok((select count(*) = 1 from pg_extension where extname = 'supabase_vault'), 'Supabase Vault is installed');
select ok((select count(*) = 0 from pg_extension where extname = 'pg_graphql'), 'pg_graphql is NOT installed (GraphQL API stays off)');

select has_schema('app_private', 'the app_private schema exists');
select has_schema('audit', 'the audit schema exists');

select ok(not has_schema_privilege('anon', 'public', 'usage'), 'anon cannot use the public schema');
select ok(not has_schema_privilege('anon', 'app_private', 'usage'), 'anon cannot use the app_private schema');
select ok(not has_schema_privilege('authenticated', 'app_private', 'usage'), 'authenticated cannot use the app_private schema');
select ok(has_schema_privilege('authenticated', 'public', 'usage'), 'authenticated can use the public schema');

select * from finish();
rollback;
