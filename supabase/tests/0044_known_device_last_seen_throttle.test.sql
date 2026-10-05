-- pgTAP — migration 0044: the fifteen-minute sighting window (F6-B, owner decision C-15 §3 and §4).
--
-- 0043's own test still covers registration, refusals and privileges, and it still passes unchanged:
-- the function's name, signature, outcomes and grants are the same. What is new is *when* a known
-- device's row is rewritten, so that is what this file proves — inside the window nothing is written at
-- all, past it the sighting moves, and neither case touches `trusted_at` or `revoked_at`.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(20);

insert into auth.users (id, email) values
  ('e0000000-0000-4000-8000-000000000001', 'throttle-owner@test.invalid');

create temporary table digests on commit drop as
  select sha256('throttled-device'::bytea) as one, sha256('other-device'::bytea) as two;

-- ---------------------------------------------------------------------------------------------------
-- The function is the same one, replaced rather than added
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'register_known_device', array['uuid','bytea','inet'],
  'app_private.register_known_device still exists with its 0043 signature');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'register_known_device'),
  1::bigint,
  'and there is exactly one of it: 0044 replaced 0043 rather than overloading it');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname = 'register_known_device'
      and (not p.prosecdef or coalesce(array_to_string(p.proconfig, ','), '') <> 'search_path=pg_catalog, public')),
  0::bigint,
  'it is still SECURITY DEFINER with the pinned search_path');
select function_privs_are('app_private', 'register_known_device', array['uuid','bytea','inet'],
  'app_system', array['EXECUTE'], 'app_system may still call it');
select function_privs_are('app_private', 'register_known_device', array['uuid','bytea','inet'],
  'authenticated', array[]::text[], 'and authenticated still may not');

-- ---------------------------------------------------------------------------------------------------
-- Registration is never throttled
-- ---------------------------------------------------------------------------------------------------
create temporary table first_seen on commit drop as
  select * from app_private.register_known_device(
    'e0000000-0000-4000-8000-000000000001', (select one from digests), '198.51.100.7'::inet);

select is((select outcome from first_seen), 'registered', 'a first sighting is recorded immediately');
select isnt((select device_id from first_seen), null, 'and returns the new row');
select is(
  (select outcome from app_private.register_known_device(
     'e0000000-0000-4000-8000-000000000001', (select two from digests), null)),
  'registered',
  'a second, different device is also recorded immediately: the window is per row, not per user');

-- ---------------------------------------------------------------------------------------------------
-- Inside the window: nothing is written
-- ---------------------------------------------------------------------------------------------------
create temporary table before_repeat on commit drop as
  select last_seen_at, last_ip, trusted_at, revoked_at, updated_at
    from public.known_devices where id = (select device_id from first_seen);

select is(
  (select outcome from app_private.register_known_device(
     'e0000000-0000-4000-8000-000000000001', (select one from digests), '203.0.113.9'::inet)),
  'seen',
  'a sighting inside the window still reports the device as known');
select is(
  (select d.last_seen_at from public.known_devices d where d.id = (select device_id from first_seen)),
  (select last_seen_at from before_repeat),
  'but last_seen_at is not moved: at most one write every fifteen minutes (C-15 §3)');
select is(
  (select d.last_ip from public.known_devices d where d.id = (select device_id from first_seen)),
  (select last_ip from before_repeat),
  'and the address is not rewritten either, because the two describe one sighting');
select is(
  (select d.updated_at from public.known_devices d where d.id = (select device_id from first_seen)),
  (select updated_at from before_repeat),
  'nothing was written at all, so the row was not even touched');

-- Ten more sightings in the same window cost nothing.
select is(
  (select count(distinct outcome) from (
     select (app_private.register_known_device(
       'e0000000-0000-4000-8000-000000000001', (select one from digests), null)).outcome
     from generate_series(1, 10)) repeats),
  1::bigint,
  'a burst of sightings reports one outcome throughout');
select is(
  (select d.updated_at from public.known_devices d where d.id = (select device_id from first_seen)),
  (select updated_at from before_repeat),
  'and still writes nothing');

-- ---------------------------------------------------------------------------------------------------
-- Past the window: the sighting moves
-- ---------------------------------------------------------------------------------------------------
update public.known_devices
   set first_seen_at = now() - interval '40 minutes', last_seen_at = now() - interval '20 minutes'
 where id = (select device_id from first_seen);

select is(
  (select outcome from app_private.register_known_device(
     'e0000000-0000-4000-8000-000000000001', (select one from digests), '203.0.113.9'::inet)),
  'seen',
  'a sighting past the window is still the same device');
select ok(
  (select d.last_seen_at > now() - interval '1 minute' from public.known_devices d
    where d.id = (select device_id from first_seen)),
  'and now last_seen_at moves');
select is(
  (select d.last_ip from public.known_devices d where d.id = (select device_id from first_seen)),
  '203.0.113.9'::inet,
  'with the address of the sighting that moved it');

-- ---------------------------------------------------------------------------------------------------
-- Neither path touches trust or revocation
-- ---------------------------------------------------------------------------------------------------
select is(
  (select array[d.trusted_at, d.revoked_at] from public.known_devices d
    where d.id = (select device_id from first_seen)),
  array[null::timestamptz, null::timestamptz],
  'trusted_at and revoked_at are untouched by a sighting, throttled or not (C-15 §3)');

-- C-15 §4: a revoked device is reported, never silently revived, and its row is left alone.
update public.known_devices
   set revoked_at = now() - interval '1 hour',
       first_seen_at = now() - interval '3 days',
       last_seen_at = now() - interval '2 days'
 where id = (select device_id from first_seen);
select is(
  (select outcome from app_private.register_known_device(
     'e0000000-0000-4000-8000-000000000001', (select one from digests), '192.0.2.5'::inet)),
  'revoked',
  'a revoked device is reported as revoked even when the window has long expired');
select isnt(
  (select d.revoked_at from public.known_devices d where d.id = (select device_id from first_seen)),
  null,
  'and its revocation is not cleared by ordinary authenticated activity (C-15 §4)');

select * from finish();
rollback;
