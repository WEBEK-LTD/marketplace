-- pgTAP — migration 0038: the authentication security-event writer (C-20).
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(19);

insert into auth.users (id, email) values
  ('c0000000-0000-4000-8000-000000000001', 'events-one@test.invalid');

-- Shape and privileges --------------------------------------------------------------------------
select has_function('app_private', 'record_auth_security_event',
  array['text', 'uuid', 'bytea', 'bytea', 'bytea', 'text', 'text'],
  'app_private.record_auth_security_event exists');

select is(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'record_auth_security_event'),
  true, 'it is SECURITY DEFINER');

select is(
  (select coalesce(array_to_string(p.proconfig, ','), '') from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'record_auth_security_event'),
  'search_path=pg_catalog, public', 'and it pins search_path');

select function_privs_are('app_private', 'record_auth_security_event',
  array['text', 'uuid', 'bytea', 'bytea', 'bytea', 'text', 'text'],
  'app_system', array['EXECUTE'], 'app_system may record an authentication event');
select function_privs_are('app_private', 'record_auth_security_event',
  array['text', 'uuid', 'bytea', 'bytea', 'bytea', 'text', 'text'],
  'authenticated', array[]::text[], 'authenticated may not');
select function_privs_are('app_private', 'record_auth_security_event',
  array['text', 'uuid', 'bytea', 'bytea', 'bytea', 'text', 'text'],
  'anon', array[]::text[], 'anon may not');
select function_privs_are('app_private', 'record_auth_security_event',
  array['text', 'uuid', 'bytea', 'bytea', 'bytea', 'text', 'text'],
  'public', array[]::text[], 'and PUBLIC may not');

-- What it writes --------------------------------------------------------------------------------
create temp table written as
select app_private.record_auth_security_event(
  'auth.login.success',
  'c0000000-0000-4000-8000-000000000001',
  '\x0102'::bytea,
  '\x0304'::bytea,
  '\x0506'::bytea,
  '11111111-2222-4333-8444-555555555555',
  'password_accepted'
) as id;

select is(
  (select e.details from public.security_events e join written w on w.id = e.id),
  jsonb_build_object(
    'identifier_hash', '0102',
    'ip_hash', '0304',
    'user_agent_hash', '0506',
    'request_id', '11111111-2222-4333-8444-555555555555',
    'reason_code', 'password_accepted'
  ),
  'the event stores hashes as hex and nothing else'
);

select ok(
  (select e.request_ip is null from public.security_events e join written w on w.id = e.id),
  'the raw client IP is never stored: C-20 asks for a pseudonymous one, which an inet column cannot hold'
);

-- An absent user agent simply disappears rather than being stored as null noise.
create temp table failure_event as
select app_private.record_auth_security_event(
  'auth.login.failure', null, '\x0102'::bytea, '\x0304'::bytea, null,
  '11111111-2222-4333-8444-555555555556', 'invalid_credentials'
) as id;

select is(
  (select e.details ? 'user_agent_hash' from public.security_events e join failure_event f on f.id = e.id),
  false,
  'an unknown user agent is omitted, and a failure may carry no user id at all'
);

-- Refusals ---------------------------------------------------------------------------------------
select throws_ok(
  $$select app_private.record_auth_security_event('auth.login.elsewhere', null, '\x01'::bytea, null, null, null, 'x_reason')$$,
  '22023',
  null,
  'an event type C-20 does not approve is refused'
);
select throws_ok(
  $$select app_private.record_auth_security_event('auth.login.failure', null, '\x01'::bytea, null, null, null, 'Reason With Spaces')$$,
  '22023',
  null,
  'a reason code that could carry a message is refused'
);
select throws_ok(
  $$select app_private.record_auth_security_event('auth.login.failure', null, null, null, null, null, 'invalid_credentials')$$,
  '22023',
  null,
  'an event with no subject at all is refused'
);

-- The identifier resolver -------------------------------------------------------------------------
select has_function('app_private', 'user_id_for_login_identifier', array['text'],
  'app_private.user_id_for_login_identifier exists');

select ok(
  (select p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') = 'search_path=pg_catalog, public'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'user_id_for_login_identifier'),
  'it is SECURITY DEFINER and pins search_path'
);

select function_privs_are('app_private', 'user_id_for_login_identifier', array['text'],
  'app_system', array['EXECUTE'], 'app_system may resolve an identifier');
select is(
  (select count(*) from (values ('authenticated'), ('anon'), ('public')) as r(role)
    where has_function_privilege(r.role,
      'app_private.user_id_for_login_identifier(text)', 'EXECUTE')),
  0::bigint,
  'and nobody else may: the answer would be an account-existence oracle'
);

select is(
  app_private.user_id_for_login_identifier('Events-One@Test.invalid'),
  'c0000000-0000-4000-8000-000000000001'::uuid,
  'an identifier resolves to its account regardless of case'
);
select is(
  app_private.user_id_for_login_identifier('nobody@test.invalid'),
  null::uuid,
  'and an identifier with no account resolves to null rather than raising'
);

select * from finish();
rollback;
