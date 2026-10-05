-- pgTAP — migration 0052: the caller's own identity reader (Phase 5-A).
--
-- Three things are worth pinning here, and they are all about what the function refuses to say.
--
--   1. It returns the two approved fields and no third one. The projection is asserted by column name
--      and by count, so a future edit that adds `phone_e164` "because it was handy" fails here.
--   2. A deleted profile has no identity at all — not a row with nulls in it, no row.
--   3. A suspended profile still has one, because suspension is not deletion and this reader does not
--      invent a sign-out rule for it.
--
-- The privilege boundary is checked too: `app_system` may execute it, `authenticated` and `anon` may
-- not, and nothing in this migration hands anybody a table privilege.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(14);

-- Fixtures ------------------------------------------------------------------------------------------
-- The 0005 sync trigger creates a profile for each of these; the updates below set the states this file
-- is about, rather than inserting profiles directly.
insert into auth.users (id, email, raw_user_meta_data) values
  ('c0000000-0000-4000-8000-000000000001', 'live@test.invalid', '{"display_name":"Nadia"}'::jsonb),
  ('c0000000-0000-4000-8000-000000000002', 'nameless@test.invalid', '{}'::jsonb),
  ('c0000000-0000-4000-8000-000000000003', 'suspended@test.invalid', '{"display_name":"Omar"}'::jsonb),
  ('c0000000-0000-4000-8000-000000000004', 'gone@test.invalid', '{"display_name":"Removed"}'::jsonb);

update public.profiles set status = 'suspended'
 where id = 'c0000000-0000-4000-8000-000000000003';

update public.profiles set status = 'deleted', deleted_at = now()
 where id = 'c0000000-0000-4000-8000-000000000004';

-- The shape of the answer -----------------------------------------------------------------------------
select set_eq(
  $$select id::text, display_name from app_private.user_identity('c0000000-0000-4000-8000-000000000001'::uuid)$$,
  $$values ('c0000000-0000-4000-8000-000000000001', 'Nadia')$$,
  'a live account resolves to its id and display name'
);

-- The projection itself, read off the returned row rather than off a catalogue string: a third column
-- added later shows up here as an extra key, whatever it is called.
select set_eq(
  $$select jsonb_object_keys(to_jsonb(u))
      from app_private.user_identity('c0000000-0000-4000-8000-000000000001'::uuid) u$$,
  $$values ('id'), ('display_name')$$,
  'the projection is exactly the two approved fields and no third one'
);

select is(
  (select count(*)::int from app_private.user_identity('c0000000-0000-4000-8000-000000000001'::uuid)),
  1,
  'one account resolves to one row'
);

-- A display name is optional --------------------------------------------------------------------------
select is(
  (select display_name from app_private.user_identity('c0000000-0000-4000-8000-000000000002'::uuid)),
  null,
  'an account with no display name resolves with a null name rather than failing'
);

select is(
  (select count(*)::int from app_private.user_identity('c0000000-0000-4000-8000-000000000002'::uuid)),
  1,
  'and it is still one row'
);

-- Suspension is not deletion ---------------------------------------------------------------------------
select is(
  (select display_name from app_private.user_identity('c0000000-0000-4000-8000-000000000003'::uuid)),
  'Omar',
  'a suspended account still has an identity: this reader invents no sign-out rule'
);

-- Deletion is ------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from app_private.user_identity('c0000000-0000-4000-8000-000000000004'::uuid)),
  0,
  'a deleted profile has no identity at all'
);

select is(
  (select count(*)::int from app_private.user_identity('c0000000-0000-4000-8000-00000000ffff'::uuid)),
  0,
  'an unknown id resolves to nothing, exactly like a deleted one'
);

-- The security boundary ---------------------------------------------------------------------------------
select is(
  (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'user_identity'),
  true,
  'the reader is SECURITY DEFINER'
);

select is(
  (select proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'user_identity'),
  array['search_path=pg_catalog, public'],
  'and pins its search_path'
);

select ok(
  has_function_privilege('app_system', 'app_private.user_identity(uuid)', 'execute'),
  'app_system may execute it'
);

select ok(
  not has_function_privilege('authenticated', 'app_private.user_identity(uuid)', 'execute'),
  'authenticated may not'
);

select ok(
  not has_function_privilege('anon', 'app_private.user_identity(uuid)', 'execute'),
  'and anon may not'
);

-- Nothing was widened -------------------------------------------------------------------------------------
select is(
  (select count(*)::int from public.security_contract_problems()),
  0,
  'the security contract still holds after this migration'
);

select * from finish();
rollback;
