-- pgTAP — migration 0003/0005: authorization helpers, database roles and the user-data RLS matrix.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(22);

-- Fixtures ------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'a@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'b@example.test'),
  ('33333333-3333-4333-8333-333333333333', 'c@example.test');

update public.profiles set status = 'suspended' where id = '33333333-3333-4333-8333-333333333333';

insert into public.roles (key, name_en, name_ar, requires_mfa, is_admin_console) values
  ('buyer', 'Buyer', 'Buyer', false, false),
  ('admin', 'Admin', 'Admin', true, true);

insert into public.permissions (key, module, description_en, description_ar) values
  ('users.profile.read', 'users', 'Read any profile', 'Read any profile'),
  ('users.role.manage', 'users', 'Manage role assignments', 'Manage role assignments');

insert into public.role_permissions (role_key, permission_key) values
  ('admin', 'users.profile.read'),
  ('admin', 'users.role.manage');

insert into public.user_roles (user_id, role_key) values
  ('11111111-1111-4111-8111-111111111111', 'admin'),
  ('22222222-2222-4222-8222-222222222222', 'buyer');

-- The profile sync trigger ---------------------------------------------------------------------------
select is((select count(*) from public.profiles), 3::bigint, 'creating an auth user creates a profile');
select is((select count(*) from public.user_settings), 3::bigint, 'creating an auth user creates user settings');

-- Database roles -------------------------------------------------------------------------------------
select has_role('app_api', 'the app_api role exists');
select has_role('app_system', 'the app_system role exists');
select has_role('app_worker', 'the app_worker role exists');

select ok(
  (select not rolinherit from pg_roles where rolname = 'app_api'),
  'app_api does not inherit: reaching data always needs SET ROLE'
);
select ok(
  (select m.set_option and not m.admin_option and not m.inherit_option
     from pg_auth_members m
     join pg_roles r on r.oid = m.roleid
     join pg_roles g on g.oid = m.member
    where r.rolname = 'authenticated' and g.rolname = 'app_api'),
  'app_api is a SET-only, non-inheriting member of authenticated (S8)'
);
select is(
  (select count(*) from information_schema.role_table_grants
    where grantee in ('app_api', 'app_system', 'app_worker') and table_schema in ('public', 'app_private', 'audit')),
  0::bigint,
  'the login roles hold no table privileges of their own'
);
select is(
  (select count(*) from information_schema.role_table_grants
    where grantee = 'anon' and table_schema in ('public', 'app_private', 'audit')),
  0::bigint,
  'anon holds no privileges on any application table'
);

-- Helper behaviour at aal1 ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","aal":"aal1"}', true);

create temp table probe_aal1 as
select public.current_user_id() as uid,
       public.is_aal2() as aal2,
       public.has_role('admin') as admin_role,
       public.has_permission('users.profile.read') as can_read_profiles,
       public.is_verified_seller() as verified_seller;

reset role;

select is((select uid from probe_aal1), '11111111-1111-4111-8111-111111111111'::uuid, 'current_user_id reads the sub claim');
select ok((select not aal2 from probe_aal1), 'is_aal2 is false for an aal1 session');
select ok((select not admin_role from probe_aal1), 'a role that requires MFA is inactive at aal1');
select ok((select not can_read_profiles from probe_aal1), 'permissions of an MFA role do not apply at aal1');
select ok((select not verified_seller from probe_aal1), 'is_verified_seller denies until 0009 replaces it');

-- Helper behaviour at aal2 ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","aal":"aal2"}', true);

create temp table probe_aal2 as
select public.is_aal2() as aal2,
       public.has_role('admin') as admin_role,
       public.has_permission('users.profile.read') as can_read_profiles,
       public.has_permission('users.role.manage') as can_manage_roles,
       (select count(*) from public.profiles) as visible_profiles;

reset role;

select ok((select aal2 from probe_aal2), 'is_aal2 is true for an aal2 session');
select ok((select admin_role from probe_aal2), 'an MFA role is active at aal2');
select ok((select can_read_profiles and can_manage_roles from probe_aal2), 'permissions apply at aal2');

-- RLS matrix: an ordinary buyer ----------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","aal":"aal1"}', true);

create temp table probe_buyer as
select (select count(*) from public.profiles) as visible_profiles,
       (select count(*) from public.user_settings) as visible_settings,
       (select count(*) from public.user_roles) as visible_roles;

reset role;

select is((select visible_profiles from probe_buyer), 2::bigint,
  'a buyer sees active profiles only (the suspended one is hidden)');
select is((select visible_settings from probe_buyer), 1::bigint, 'a buyer sees only their own settings');
select is((select visible_roles from probe_buyer), 1::bigint, 'a buyer sees only their own role assignments');

select is((select visible_profiles from probe_aal2), 3::bigint,
  'an administrator with users.profile.read sees suspended profiles too');

-- RLS matrix: writing on behalf of someone else ------------------------------------------------------
insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled, is_pricing_enabled, is_checkout_enabled)
values ('XTS', '963', 'T', 2, true, true, true);
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code, default_currency_code, is_marketplace_enabled)
values ('ZZ', 'ZZZ', '999', 'Test country', 'Test country', '999', 'XTS', true);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","aal":"aal1"}', true);

select throws_ok(
  $$insert into public.addresses (user_id, recipient_name, phone_e164, country_code, governorate, city, street_address)
    values ('11111111-1111-4111-8111-111111111111', 'Someone Else', '+201000000000', 'ZZ', 'G', 'C', 'S')$$,
  '42501',
  null,
  'a user cannot create an address for another user'
);

reset role;

select * from finish();
rollback;
