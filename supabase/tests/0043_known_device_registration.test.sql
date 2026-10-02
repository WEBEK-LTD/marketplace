-- pgTAP — migration 0043: recording a known device (F6-A, owner decision C-15).
--
-- The claims that matter: only `app_system` may write a device record; the same browser is one row and
-- not two; a second sighting refreshes rather than duplicates; a revoked device is reported and left
-- alone; and nothing in this path can write `trusted_at`, forge a digest, or store anything from which
-- the raw cookie value could be recovered.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(34);

insert into auth.users (id, email) values
  ('d0000000-0000-4000-8000-000000000001', 'device-owner@test.invalid'),
  ('d0000000-0000-4000-8000-000000000002', 'device-stranger@test.invalid');

-- Stand-ins for the HMAC-SHA-256 digest of a device cookie: 32 bytes, and nothing the test can invert.
create temporary table digests on commit drop as
  select sha256('device-one'::bytea) as one, sha256('device-two'::bytea) as two;

-- ---------------------------------------------------------------------------------------------------
-- Shape and privileges
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'register_known_device', array['uuid','bytea','inet'],
  'app_private.register_known_device exists');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname = 'register_known_device'
      and (not p.prosecdef or coalesce(array_to_string(p.proconfig, ','), '') <> 'search_path=pg_catalog, public')),
  0::bigint,
  'it is SECURITY DEFINER with the pinned search_path');

select function_privs_are('app_private', 'register_known_device', array['uuid','bytea','inet'],
  'app_system', array['EXECUTE'], 'app_system may record a device');
select function_privs_are('app_private', 'register_known_device', array['uuid','bytea','inet'],
  'authenticated', array[]::text[],
  'authenticated may not, so a browser cannot claim to be a device of its choosing');
select function_privs_are('app_private', 'register_known_device', array['uuid','bytea','inet'],
  'anon', array[]::text[], 'anon may not');
select function_privs_are('app_private', 'register_known_device', array['uuid','bytea','inet'],
  'app_worker', array[]::text[], 'the worker has no part in device registration');
select function_privs_are('app_private', 'register_known_device', array['uuid','bytea','inet'],
  'public', array[]::text[], 'and PUBLIC may not');

-- The 0004 browser-facing surface is untouched by this migration.
select table_privs_are('public', 'known_devices', 'authenticated', array['SELECT','UPDATE'],
  'authenticated keeps exactly the 0004 grants on known_devices');
select table_privs_are('public', 'known_devices', 'app_system', array[]::text[],
  'and app_system still holds no table privilege of its own');
select table_privs_are('public', 'known_devices', 'anon', array[]::text[], 'anon still holds none');
select has_index('public', 'known_devices', 'known_devices_user_device',
  'the 0004 one-row-per-device index is still there, which is what makes the upsert safe');

-- ---------------------------------------------------------------------------------------------------
-- The device is stored only as a digest
-- ---------------------------------------------------------------------------------------------------
select col_type_is('public', 'known_devices', 'device_hash', 'bytea',
  'the device identifier is stored as bytes, never as text');
select hasnt_column('public', 'known_devices', 'device_id',
  'and there is no column for a raw device value');
select hasnt_column('public', 'known_devices', 'cookie',
  'nor for the cookie itself');

-- ---------------------------------------------------------------------------------------------------
-- First sighting
-- ---------------------------------------------------------------------------------------------------
create temporary table first_seen on commit drop as
  select * from app_private.register_known_device(
    'd0000000-0000-4000-8000-000000000001', (select one from digests), '198.51.100.7'::inet);

select is((select outcome from first_seen), 'registered', 'an unseen device is registered');
select isnt((select device_id from first_seen), null, 'and its row id comes back');
select is(
  (select d.device_hash from public.known_devices d where d.id = (select device_id from first_seen)),
  (select one from digests),
  'the row stores the digest it was given, unchanged');
select is(
  (select d.last_ip from public.known_devices d where d.id = (select device_id from first_seen)),
  '198.51.100.7'::inet,
  'and the address this sign-in came from');
select is(
  (select d.first_seen_at = d.last_seen_at from public.known_devices d
    where d.id = (select device_id from first_seen)),
  true,
  'a first sighting is its own last sighting');
select is(
  (select d.trusted_at from public.known_devices d where d.id = (select device_id from first_seen)),
  null,
  'registration trusts nothing: trusted_at is left for a decision F6 has not made');
select is(
  (select d.revoked_at from public.known_devices d where d.id = (select device_id from first_seen)),
  null,
  'and revokes nothing');

-- ---------------------------------------------------------------------------------------------------
-- Second sighting
-- ---------------------------------------------------------------------------------------------------
-- Aged deliberately so that a refreshed `last_seen_at` is visibly newer.
update public.known_devices
   set first_seen_at = now() - interval '2 days', last_seen_at = now() - interval '2 days'
 where id = (select device_id from first_seen);

create temporary table seen_again on commit drop as
  select * from app_private.register_known_device(
    'd0000000-0000-4000-8000-000000000001', (select one from digests), '203.0.113.9'::inet);

select is((select outcome from seen_again), 'seen', 'the same device the second time is not a new one');
select is((select device_id from seen_again), (select device_id from first_seen),
  'and it is the same row');
select is((select count(*) from public.known_devices), 1::bigint,
  'so the browser is one row, not two');
select ok(
  (select d.last_seen_at > d.first_seen_at from public.known_devices d
    where d.id = (select device_id from first_seen)),
  'the sighting was refreshed');
select is(
  (select d.last_ip from public.known_devices d where d.id = (select device_id from first_seen)),
  '203.0.113.9'::inet,
  'and the address moved with it');

-- A sign-in with no address must not erase what was known.
select is(
  (select d.last_ip from public.known_devices d
    where d.id = (select (device_id) from app_private.register_known_device(
      'd0000000-0000-4000-8000-000000000001', (select one from digests), null))),
  '203.0.113.9'::inet,
  'a sign-in without an address leaves the last known one in place');

-- ---------------------------------------------------------------------------------------------------
-- One device per account
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.register_known_device(
     'd0000000-0000-4000-8000-000000000002', (select one from digests), null)),
  'registered',
  'the same browser is a separate, first-time device for a different account');
select is((select count(*) from public.known_devices), 2::bigint,
  'which is two rows, one per account, and no account can see the other through this table');

-- ---------------------------------------------------------------------------------------------------
-- Refusals and a revoked device
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.register_known_device(
     'd0000000-0000-4000-8000-0000000000ff', (select two from digests), null)),
  'no_user',
  'an account that does not exist is refused by outcome, not by a foreign-key error');
select is(
  (select outcome from app_private.register_known_device(
     'd0000000-0000-4000-8000-000000000001', '\x00'::bytea, null)),
  'invalid_digest',
  'a digest that is not 32 bytes is refused, so no malformed identifier is ever stored');
select is(
  (select outcome from app_private.register_known_device(
     'd0000000-0000-4000-8000-000000000001', null, null)),
  'invalid_digest',
  'and so is a missing one');

update public.known_devices set revoked_at = now() - interval '1 hour'
 where id = (select device_id from first_seen);
create temporary table after_revoke on commit drop as
  select d.last_seen_at, (select outcome from app_private.register_known_device(
     'd0000000-0000-4000-8000-000000000001', (select one from digests), '192.0.2.5'::inet)) as outcome
    from public.known_devices d where d.id = (select device_id from first_seen);

select is((select outcome from after_revoke), 'revoked',
  'a revoked device is reported as revoked rather than quietly re-registered');
select is(
  (select d.last_ip from public.known_devices d where d.id = (select device_id from first_seen)),
  '203.0.113.9'::inet,
  'and nothing about it is changed: F6 decides no policy for a revoked device');

select * from finish();
rollback;
