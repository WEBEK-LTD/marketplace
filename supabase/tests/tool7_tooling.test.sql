-- TOOL-7 pgTAP tooling test (owner decision E6, Phase 1 Step 9).
-- Proves that pgTAP runs through `supabase test db --local` on the ephemeral stack. It is not an
-- application test: Phase 1 has no application schema. Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(5);

select ok((select count(*) = 1 from pg_extension where extname = 'pgtap'), 'pgTAP is installed');
select has_role('anon', 'the Supabase anon role exists');
select has_role('authenticated', 'the Supabase authenticated role exists');
select has_role('service_role', 'the Supabase service_role role exists');
select ok(
  (select count(*) = 0 from pg_namespace where nspname in ('b10_local_probe', 'tool3')),
  'no B10-local or TOOL-3 fixture schema was left behind'
);

select * from finish();
rollback;
