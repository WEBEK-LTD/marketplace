-- TOOL-3 throwaway fixtures (owner decision S9). NOT a migration and NOT Phase 2 schema.
-- Applied through the direct admin connection before a TOOL-3 run and removed afterwards.
-- Expects the Supabase `authenticated` role to exist. The password literal is inserted per run.
create schema tool3;

-- Fixture-only login role. Membership follows the approved Phase 2 model for app_api (S8):
-- no inherited privileges; it can only act through SET ROLE authenticated.
create role tool3_app_api login noinherit password __FIXTURE_PASSWORD_LITERAL__;
grant authenticated to tool3_app_api with inherit false, set true;

create table tool3.notes (
  id bigint generated always as identity primary key,
  owner_sub text not null,
  body text not null
);
-- RLS applies to authenticated (the role under test); the table owner (admin) only inserts fixture rows.
alter table tool3.notes enable row level security;

create function tool3.claim_sub() returns text
language sql stable
as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub' $$;

grant usage on schema tool3 to authenticated;
grant execute on function tool3.claim_sub() to authenticated;
grant select on tool3.notes to authenticated;

create policy notes_select_own on tool3.notes
  for select to authenticated
  using (owner_sub = tool3.claim_sub());
