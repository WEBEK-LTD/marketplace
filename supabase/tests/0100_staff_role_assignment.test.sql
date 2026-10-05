-- 0100 — The first writer `public.user_roles` has ever had, and every boundary it must hold.
--
-- What is proven here, in order: the five functions have the shape and privileges S8 requires, and the worker
-- can execute none of them; the ceiling is `roles.sort_order` read through 0003's own effectiveness rule, so a
-- manager at `aal1`, a manager whose grant expired and a manager whose grant was revoked all have no ceiling
-- and can grant nothing; the grantable set is **computed in the database** and contains exactly what the writer
-- accepts — never `super_admin`, never a role `roles.is_assignable` refuses, never a role above the caller's
-- own highest effective role; a lateral grant of the caller's own level is allowed; a self-grant and a
-- self-revoke are both refused; a blank reason is refused on both writers; an expiry that is not in the future
-- is refused and a future one is stored; revocation is an **update** that leaves the row, its grant and its
-- history in place, and 0078's reader immediately reports the grant as not effective; a second revocation is
-- refused rather than overwriting the first; reinstatement happens only through an explicit new grant, which
-- records a fresh actor, moment and reason; an unknown account, an unknown role key and a missing key are one
-- indistinguishable absence; and `super_admin` can be neither granted nor revoked here by anybody, including a
-- `super_admin`.
--
-- **The ceiling on revocation is an approved owner decision**, confirmed on delivery: it applies to
-- withdrawal exactly as it does to granting, no role-management operation may remove a role above the
-- caller's effective ceiling, and `STAFF_ROLE_NOT_REVOCABLE` stays. The assertions covering it below are
-- therefore pinning a contract rather than an implementer's choice.
--
-- Also proven: the revocation takes effect on the next evaluation of the predicates, which is what "the
-- target's next request" means in a platform that cannot end a session — and nothing in either writer names a
-- session, a sign-out or 8-B's audit channel; no permission key was seeded; the role catalogue, its
-- permissions and `requires_mfa` are untouched; 0078's and 0079's read surfaces are unchanged; and the two
-- closed guards that asserted nothing writes `public.user_roles` now name these two writers and nothing else.

-- Deterministic: fixed uuids, explicit states, and every assertion inside a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(222);

-- ---------------------------------------------------------------------------------------------------
-- The shapes
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'staff_role_can_manage', array['uuid', 'boolean'],
  'the permission predicate exists');
select has_function('app_private', 'staff_role_ceiling', array['uuid', 'boolean'],
  'the ceiling function exists');
select has_function('app_private', 'staff_role_grantable', array['uuid', 'boolean'],
  'the grantable-set reader exists');
select has_function('app_private', 'staff_role_grant',
  array['uuid', 'boolean', 'uuid', 'text', 'text', 'timestamptz'], 'the grant writer exists');
select has_function('app_private', 'staff_role_revoke',
  array['uuid', 'boolean', 'uuid', 'text', 'text'], 'the revoke writer exists');

select function_returns('app_private', 'staff_role_can_manage', array['uuid', 'boolean'], 'boolean',
  'the predicate answers a boolean');
select function_returns('app_private', 'staff_role_ceiling', array['uuid', 'boolean'], 'integer',
  'the ceiling answers a sort order');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'staff_role%' and p.prosecdef),
  5, 'all five are security definer');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'staff_role%'
      and p.proconfig @> array['search_path=pg_catalog, public']),
  5, 'and all five pin the search path, as S8 requires');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'staff_role%' and p.provolatile = 'v'),
  2, 'exactly two are volatile: the writers');

select is((select count(*) from public.security_contract_problems()), 0::bigint,
  'the security contract holds with all five added');
select is((select count(*) from public.audit_attribution_problems()), 0::bigint,
  'and no function here names 8-B''s audit channel');

-- ---------------------------------------------------------------------------------------------------
-- Privileges: app_system only, and never the worker
-- ---------------------------------------------------------------------------------------------------
select ok(has_function_privilege('app_system', p.oid, 'execute'),
    format('app_system may execute %s', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname like 'staff_role%'
 order by p.proname;

-- The worker runs unattended, so it is the one process that must never change who holds a role.
select ok(not has_function_privilege(r.rolname, p.oid, 'execute'),
    format('%s may not execute %s', r.rolname, p.proname))
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('public'), ('anon'), ('authenticated'), ('app_worker')) as r(rolname)
 where n.nspname = 'app_private' and p.proname like 'staff_role%'
 order by r.rolname, p.proname;

select ok(not has_table_privilege('app_system', 'public.user_roles', 'insert'),
  'app_system holds no insert on public.user_roles: the writers are the only route');
select ok(not has_table_privilege('app_system', 'public.user_roles', 'update'),
  'and no update');
select ok(not has_table_privilege('app_system', 'public.user_roles', 'delete'),
  'and no delete, which is what makes "never a delete" structural');
select ok(not has_table_privilege('app_worker', 'public.user_roles', 'select'),
  'and the worker holds nothing on the table at all');
select ok(not has_table_privilege('app_system', 'public.roles', 'update'),
  'nor any update on the role catalogue');
select ok(not has_table_privilege('app_system', 'public.role_permissions', 'insert'),
  'nor on what a role permits');

-- ---------------------------------------------------------------------------------------------------
-- The catalogue and the keys are 0033's, untouched
-- ---------------------------------------------------------------------------------------------------
select is((select count(*) from public.roles), 7::bigint, 'there are still 0033''s seven roles');
select is(
  (select array_agg(key order by sort_order) from public.roles),
  array['guest', 'buyer', 'seller', 'moderator', 'support_agent', 'admin', 'super_admin'],
  'in 0033''s own order, which is the ceiling this increment reads');
select ok(not (select is_assignable from public.roles where key = 'guest'),
  'guest is still the one role that is not assignable');
select ok((select is_assignable from public.roles where key = 'admin'), 'and admin still is');
select ok((select requires_mfa from public.roles where key = 'admin'),
  'admin still requires MFA, which is why aal1 holds nothing');
select ok(exists (select 1 from public.permissions where key = 'users.role.manage'),
  'the key this increment uses is the one 0033 already seeded');
select ok(
  not exists (select 1 from public.permissions where key like 'users.role.%'
               and key not in ('users.role.read', 'users.role.manage')),
  'and no third role key was invented');
select is(
  (select count(*) from public.role_permissions where permission_key = 'users.role.manage'),
  2::bigint, 'users.role.manage is still granted to exactly the two roles 0033 gives it');
select is(
  (select array_agg(role_key order by role_key) from public.role_permissions
    where permission_key = 'users.role.manage'),
  array['admin', 'super_admin'], 'admin and super_admin');

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
-- `boss` and `peer` are administrators (sort_order 6). `super` is a super_admin (7). `target` holds nothing.
-- `mod` is a moderator (4) and holds no manage key. `lead` holds a bespoke role at sort_order 4 that *does*
-- carry `users.role.manage`, which is how the ceiling is tested without changing what a seeded role permits.
insert into auth.users (id, email) values
  ('da100000-0000-4000-8000-000000000001', 'role-boss@example.test'),
  ('da100000-0000-4000-8000-000000000002', 'role-target@example.test'),
  ('da100000-0000-4000-8000-000000000003', 'role-super@example.test'),
  ('da100000-0000-4000-8000-000000000004', 'role-mod@example.test'),
  ('da100000-0000-4000-8000-000000000005', 'role-lead@example.test'),
  ('da100000-0000-4000-8000-000000000006', 'role-peer@example.test');

-- `is_assignable` false on purpose: a manager may hold a role that nobody can be granted, and its sort_order
-- still sets their ceiling. Both halves of that are asserted below.
insert into public.roles (key, name_en, name_ar, requires_mfa, is_admin_console, is_assignable, sort_order)
  values ('rota_lead_0100', 'Rota lead', 'قائد المناوبات', true, true, false, 4);
insert into public.role_permissions (role_key, permission_key) values
  ('rota_lead_0100', 'users.role.manage'),
  ('rota_lead_0100', 'users.role.read');

insert into public.user_roles (user_id, role_key) values
  ('da100000-0000-4000-8000-000000000001', 'admin'),
  ('da100000-0000-4000-8000-000000000003', 'super_admin'),
  ('da100000-0000-4000-8000-000000000004', 'moderator'),
  ('da100000-0000-4000-8000-000000000005', 'rota_lead_0100'),
  ('da100000-0000-4000-8000-000000000006', 'admin');

create function pg_temp.boss() returns uuid language sql immutable as
  $f$ select 'da100000-0000-4000-8000-000000000001'::uuid $f$;
create function pg_temp.target() returns uuid language sql immutable as
  $f$ select 'da100000-0000-4000-8000-000000000002'::uuid $f$;
create function pg_temp.super() returns uuid language sql immutable as
  $f$ select 'da100000-0000-4000-8000-000000000003'::uuid $f$;
create function pg_temp.moderator() returns uuid language sql immutable as
  $f$ select 'da100000-0000-4000-8000-000000000004'::uuid $f$;
create function pg_temp.lead() returns uuid language sql immutable as
  $f$ select 'da100000-0000-4000-8000-000000000005'::uuid $f$;
create function pg_temp.peer() returns uuid language sql immutable as
  $f$ select 'da100000-0000-4000-8000-000000000006'::uuid $f$;
create function pg_temp.nobody_at_all() returns uuid language sql immutable as
  $f$ select 'da100000-0000-4000-8000-0000000000ff'::uuid $f$;

-- Shorthands, so each assertion below reads as the rule it is about rather than as a call.
create function pg_temp.grant_outcome(p_actor uuid, p_aal2 boolean, p_target uuid, p_role text,
                                      p_reason text default 'A recorded reason',
                                      p_expires timestamptz default null)
returns text language sql as $f$
  select outcome from app_private.staff_role_grant(p_actor, p_aal2, p_target, p_role, p_reason, p_expires);
$f$;
create function pg_temp.revoke_outcome(p_actor uuid, p_aal2 boolean, p_target uuid, p_role text,
                                       p_reason text default 'A recorded reason')
returns text language sql as $f$
  select outcome from app_private.staff_role_revoke(p_actor, p_aal2, p_target, p_role, p_reason);
$f$;

-- ---------------------------------------------------------------------------------------------------
-- The permission predicate
-- ---------------------------------------------------------------------------------------------------
select ok(app_private.staff_role_can_manage(pg_temp.boss(), true),
  'an administrator holds users.role.manage at aal2');
select ok(app_private.staff_role_can_manage(pg_temp.super(), true), 'and so does a super_admin');
select ok(app_private.staff_role_can_manage(pg_temp.lead(), true), 'and the bespoke rota lead');
select ok(not app_private.staff_role_can_manage(pg_temp.boss(), false),
  'and nobody holds it at aal1, because every role that carries it requires MFA');
select ok(not app_private.staff_role_can_manage(pg_temp.boss(), null),
  'a null assurance level is not an assurance');
select ok(not app_private.staff_role_can_manage(pg_temp.moderator(), true),
  'a moderator does not hold it');
select ok(not app_private.staff_role_can_manage(pg_temp.target(), true),
  'nor an account with no role');
select ok(not app_private.staff_role_can_manage(null, true), 'nor nobody at all');
select ok(not app_private.staff_role_can_manage(pg_temp.nobody_at_all(), true),
  'nor an account that does not exist');

-- ---------------------------------------------------------------------------------------------------
-- The ceiling, which is 0003's effectiveness rule applied to sort_order
-- ---------------------------------------------------------------------------------------------------
select is(app_private.staff_role_ceiling(pg_temp.boss(), true), 6,
  'an administrator''s ceiling is admin''s own sort_order');
select is(app_private.staff_role_ceiling(pg_temp.super(), true), 7, 'a super_admin''s is seven');
select is(app_private.staff_role_ceiling(pg_temp.moderator(), true), 4, 'a moderator''s is four');
select is(app_private.staff_role_ceiling(pg_temp.lead(), true), 4,
  'and the rota lead''s is four, from a role nobody can be granted: the ceiling does not read is_assignable');
select is(app_private.staff_role_ceiling(pg_temp.target(), true), null,
  'an account with no role has no ceiling at all');
select is(app_private.staff_role_ceiling(pg_temp.boss(), false), null,
  'and neither has an administrator at aal1: MFA is part of the rule');
select is(app_private.staff_role_ceiling(pg_temp.boss(), null), null, 'nor at a null assurance level');
select is(app_private.staff_role_ceiling(null, true), null, 'nor nobody at all');

-- A revoked grant and an expired grant both count for nothing, which is the same rule every predicate uses.
insert into public.user_roles (user_id, role_key, granted_at, revoked_at)
  values (pg_temp.target(), 'admin', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z');
select is(app_private.staff_role_ceiling(pg_temp.target(), true), null,
  'a revoked grant gives no ceiling');
select ok(not app_private.staff_role_can_manage(pg_temp.target(), true),
  'and no key either');
update public.user_roles
   set revoked_at = null, granted_at = '2025-01-01T00:00:00Z', expires_at = '2025-06-01T00:00:00Z'
 where user_id = pg_temp.target() and role_key = 'admin';
select is(app_private.staff_role_ceiling(pg_temp.target(), true), null,
  'an expired grant gives no ceiling');
select ok(not app_private.staff_role_can_manage(pg_temp.target(), true), 'and no key');
delete from public.user_roles where user_id = pg_temp.target();
select is(app_private.staff_role_ceiling(pg_temp.target(), true), null, 'and the fixture is clean again');

-- ---------------------------------------------------------------------------------------------------
-- The grantable set is computed in the database
-- ---------------------------------------------------------------------------------------------------
select is(
  (select array_agg(role_key order by sort_order) from app_private.staff_role_grantable(pg_temp.boss(), true)),
  array['buyer', 'seller', 'moderator', 'support_agent', 'admin'],
  'an administrator may grant five roles: everything assignable up to their own level');
select ok(
  not exists (select 1 from app_private.staff_role_grantable(pg_temp.boss(), true) where role_key = 'super_admin'),
  'and never super_admin (owner decision 1)');
select ok(
  not exists (select 1 from app_private.staff_role_grantable(pg_temp.boss(), true) where role_key = 'guest'),
  'nor guest, which is not assignable');
select ok(
  not exists (select 1 from app_private.staff_role_grantable(pg_temp.boss(), true)
               where role_key = 'rota_lead_0100'),
  'nor the bespoke role, for the same reason');

select ok(
  not exists (select 1 from app_private.staff_role_grantable(pg_temp.super(), true) where role_key = 'super_admin'),
  'a super_admin may not grant super_admin either: it is excluded by key, not by position');
select is(
  (select array_agg(role_key order by sort_order) from app_private.staff_role_grantable(pg_temp.super(), true)),
  array['buyer', 'seller', 'moderator', 'support_agent', 'admin'],
  'so the highest grantable role in this console is admin, whoever is asking');

select is(
  (select array_agg(role_key order by sort_order) from app_private.staff_role_grantable(pg_temp.lead(), true)),
  array['buyer', 'seller', 'moderator'],
  'the rota lead''s ceiling stops the set at their own sort_order');
select ok(
  not exists (select 1 from app_private.staff_role_grantable(pg_temp.lead(), true)
               where role_key in ('support_agent', 'admin')),
  'so support_agent and admin are absent for them');

select is((select count(*) from app_private.staff_role_grantable(pg_temp.moderator(), true)), 0::bigint,
  'a caller without the manage key sees no grantable role at all');
select is((select count(*) from app_private.staff_role_grantable(pg_temp.boss(), false)), 0::bigint,
  'and neither does an administrator at aal1');
select is((select count(*) from app_private.staff_role_grantable(pg_temp.target(), true)), 0::bigint,
  'nor an account with no role');
select is((select count(*) from app_private.staff_role_grantable(null, true)), 0::bigint, 'nor nobody at all');
select is(
  (select count(*) from app_private.staff_role_grantable(pg_temp.moderator(), true)),
  (select count(*) from app_private.staff_role_grantable(pg_temp.target(), true)),
  'an empty set and a refusal are indistinguishable, as on every read in this console');

-- The set and the writer agree, which is the property that makes a server-side set worth having.
select ok(
  (select bool_and(pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.target(), g.role_key) = 'granted')
     from app_private.staff_role_grantable(pg_temp.boss(), true) g),
  'every role the database offers an administrator is one the writer accepts');
delete from public.user_roles where user_id = pg_temp.target();
select ok(
  (select bool_and(pg_temp.grant_outcome(pg_temp.lead(), true, pg_temp.target(), g.role_key) = 'granted')
     from app_private.staff_role_grantable(pg_temp.lead(), true) g),
  'and the same holds for the rota lead''s smaller set');
delete from public.user_roles where user_id = pg_temp.target();
select ok(
  (select bool_and(pg_temp.grant_outcome(pg_temp.lead(), true, pg_temp.target(), r.key) <> 'granted')
     from public.roles r
    where r.key not in (select role_key from app_private.staff_role_grantable(pg_temp.lead(), true))),
  'and every role it does not offer them is one the writer refuses');
select is((select count(*) from public.user_roles where user_id = pg_temp.target()), 0::bigint,
  'none of those refusals wrote anything');

-- ---------------------------------------------------------------------------------------------------
-- Granting: the ceiling
-- ---------------------------------------------------------------------------------------------------
select is(pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.target(), 'moderator'), 'granted',
  'an administrator grants a moderator');
select is((select role_key from public.user_roles where user_id = pg_temp.target()), 'moderator',
  'and the row says so');
select is(pg_temp.grant_outcome(pg_temp.lead(), true, pg_temp.target(), 'admin'), 'role_above_ceiling',
  'the rota lead may not grant admin, which is above their own level');
select is(pg_temp.grant_outcome(pg_temp.lead(), true, pg_temp.target(), 'support_agent'),
  'role_above_ceiling', 'nor support_agent, one step above it');
select is(pg_temp.grant_outcome(pg_temp.lead(), true, pg_temp.target(), 'moderator'), 'granted',
  'but their own level is allowed');
select is(pg_temp.grant_outcome(pg_temp.target(), true, pg_temp.peer(), 'buyer'), 'not_found',
  'an account with no role grants nothing, and learns nothing from the refusal');
select is(pg_temp.grant_outcome(pg_temp.moderator(), true, pg_temp.target(), 'buyer'), 'not_found',
  'nor a moderator, who holds no manage key');
select is(pg_temp.grant_outcome(pg_temp.boss(), false, pg_temp.target(), 'buyer'), 'not_found',
  'nor an administrator at aal1');
select is(pg_temp.grant_outcome(pg_temp.boss(), null, pg_temp.target(), 'buyer'), 'not_found',
  'nor at a null assurance level');
select is(pg_temp.grant_outcome(null, true, pg_temp.target(), 'buyer'), 'not_found', 'nor nobody at all');

-- ---------------------------------------------------------------------------------------------------
-- Granting: super_admin is never grantable, and the lateral grant is
-- ---------------------------------------------------------------------------------------------------
select is(pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.target(), 'super_admin'),
  'role_not_grantable', 'an administrator may not grant super_admin');
select is(pg_temp.grant_outcome(pg_temp.super(), true, pg_temp.target(), 'super_admin'),
  'role_not_grantable', 'and neither may a super_admin: the console never creates one');
select ok(
  not exists (select 1 from public.user_roles where user_id = pg_temp.target() and role_key = 'super_admin'),
  'so no super_admin grant exists anywhere after those attempts');

-- Owner decision 3: the same level is allowed, and never above it.
select is(pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.target(), 'admin'), 'granted',
  'an administrator may grant admin — the lateral grant is permitted (owner decision 3)');
select is((select role_key from public.user_roles where user_id = pg_temp.target() and role_key = 'admin'),
  'admin', 'and it is recorded');
select is(pg_temp.grant_outcome(pg_temp.lead(), true, pg_temp.peer(), 'moderator'), 'granted',
  'the rota lead may grant their own level too');
select is(pg_temp.grant_outcome(pg_temp.lead(), true, pg_temp.peer(), 'rota_lead_0100'),
  'role_not_assignable', 'but not their own role, which is not assignable');
delete from public.user_roles where user_id = pg_temp.peer() and role_key = 'moderator';

-- ---------------------------------------------------------------------------------------------------
-- Granting: the non-assignable role, and unknown names
-- ---------------------------------------------------------------------------------------------------
select is(pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.target(), 'guest'), 'role_not_assignable',
  'guest is refused by roles.is_assignable, which gets its first reader here');
select is(pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.target(), 'wizard'), 'not_found',
  'a role key that names no role is an absence');
select is(pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.target(), ''), 'not_found',
  'and so is an empty role key');
select is(pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.target(), '   '), 'not_found',
  'or a blank one');
select is(pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.target(), null), 'not_found',
  'or none at all');
select is(pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.nobody_at_all(), 'moderator'), 'not_found',
  'an account that does not exist is an absence');
select is(pg_temp.grant_outcome(pg_temp.boss(), true, null, 'moderator'), 'not_found',
  'and so is no account at all');
select is(
  pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.nobody_at_all(), 'moderator'),
  pg_temp.grant_outcome(pg_temp.moderator(), true, pg_temp.target(), 'moderator'),
  'a missing account and a missing key answer identically');

-- A role key is matched exactly: case is not folded and whitespace is trimmed rather than accepted.
select is(pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.target(), 'MODERATOR'), 'not_found',
  'the role key is matched exactly, not case-folded');
select is(pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.target(), '  moderator  '), 'granted',
  'surrounding whitespace is trimmed rather than making the key unknown');

-- ---------------------------------------------------------------------------------------------------
-- Granting and revoking: self-action is refused (owner decision 2)
-- ---------------------------------------------------------------------------------------------------
select is(pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.boss(), 'moderator'), 'role_is_self',
  'an administrator may not grant themselves a role');
select is(pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.boss(), 'admin'), 'role_is_self',
  'not even the one they already hold');
select is(pg_temp.grant_outcome(pg_temp.super(), true, pg_temp.super(), 'admin'), 'role_is_self',
  'nor may a super_admin');
select is(pg_temp.revoke_outcome(pg_temp.boss(), true, pg_temp.boss(), 'admin'), 'role_is_self',
  'and nobody may revoke their own role');
select is(pg_temp.revoke_outcome(pg_temp.super(), true, pg_temp.super(), 'super_admin'), 'role_is_self',
  'a super_admin included — self is checked before the role is');
select is((select count(*) from public.user_roles where user_id = pg_temp.boss()), 1::bigint,
  'the administrator still holds exactly what they held');
select is((select role_key from public.user_roles where user_id = pg_temp.boss()), 'admin', 'namely admin');
select is((select revoked_at from public.user_roles where user_id = pg_temp.boss()), null,
  'un-revoked');

-- Two administrators may act on each other, which is what makes the self rule a rule about self.
select is(pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.peer(), 'support_agent'), 'granted',
  'one administrator may grant another a role');
select is(pg_temp.revoke_outcome(pg_temp.peer(), true, pg_temp.boss(), 'admin'), 'revoked',
  'and one administrator may revoke another''s');
-- Put it back: the rest of this suite needs the administrator to be one.
select is(pg_temp.grant_outcome(pg_temp.peer(), true, pg_temp.boss(), 'admin'), 'granted',
  'and reinstate it');
select ok(app_private.staff_role_can_manage(pg_temp.boss(), true),
  'so the administrator holds the key again');
delete from public.user_roles where user_id = pg_temp.peer() and role_key = 'support_agent';

-- ---------------------------------------------------------------------------------------------------
-- The reason is required on both writers (owner decision 7)
-- ---------------------------------------------------------------------------------------------------
select is(pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.target(), 'seller', null),
  'role_reason_required', 'a grant with no reason is refused');
select is(pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.target(), 'seller', ''),
  'role_reason_required', 'an empty reason is refused');
select is(pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.target(), 'seller', '    '),
  'role_reason_required', 'a reason of spaces is refused');
select is(pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.target(), 'seller', E'\t\n '),
  'role_reason_required', 'and one of tabs and newlines');
select is(pg_temp.revoke_outcome(pg_temp.boss(), true, pg_temp.target(), 'moderator', null),
  'role_reason_required', 'a revocation with no reason is refused');
select is(pg_temp.revoke_outcome(pg_temp.boss(), true, pg_temp.target(), 'moderator', '   '),
  'role_reason_required', 'and a blank one');
select ok(
  (select revoked_at is null from public.user_roles
    where user_id = pg_temp.target() and role_key = 'moderator'),
  'and the grant survived both of those attempts');

-- A reason that is only surrounded by whitespace is stored trimmed.
select is(pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.target(), 'seller', '  Joining the pilot  '),
  'granted', 'a reason with surrounding whitespace is accepted');
select is(
  (select reason from public.user_roles where user_id = pg_temp.target() and role_key = 'seller'),
  'Joining the pilot', 'and stored trimmed');

-- ---------------------------------------------------------------------------------------------------
-- The expiry (owner decision 4)
-- ---------------------------------------------------------------------------------------------------
select is(
  pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.target(), 'buyer', 'Temporary cover',
                        now() + interval '7 days'),
  'granted', 'an expiry in the future is accepted');
select ok(
  (select expires_at > now() from public.user_roles where user_id = pg_temp.target() and role_key = 'buyer'),
  'and stored as given');
select is(
  pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.target(), 'support_agent', 'Cover',
                        '2020-01-01T00:00:00Z'),
  'role_expiry_invalid', 'an expiry in the past is refused');
select is(
  pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.target(), 'support_agent', 'Cover', now()),
  'role_expiry_invalid', 'and so is one at this very moment, which the constraint would refuse');
select ok(
  not exists (select 1 from public.user_roles where user_id = pg_temp.target() and role_key = 'support_agent'),
  'so nothing was written for either');
select is(
  pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.target(), 'support_agent', 'Cover', null),
  'granted', 'and no expiry at all means a grant that does not expire');
select is(
  (select expires_at from public.user_roles where user_id = pg_temp.target() and role_key = 'support_agent'),
  null, 'which is what a null expiry is');

-- 0003's own constraint is still the floor under all of that.
select ok(
  exists (select 1 from pg_constraint
           where conrelid = 'public.user_roles'::regclass and conname = 'user_roles_expiry_after_grant'),
  '0003''s expiry constraint is untouched');
select ok(
  exists (select 1 from pg_constraint
           where conrelid = 'public.user_roles'::regclass and conname = 'user_roles_revoked_has_time'),
  'and so is its revocation constraint');

-- An expired grant stops counting without anything being written, which is what an expiry is for.
update public.user_roles set granted_at = now() - interval '2 days', expires_at = now() - interval '1 day'
 where user_id = pg_temp.target() and role_key = 'buyer';
select ok(
  not (select is_effective from app_private.admin_user_roles(pg_temp.boss(), true, pg_temp.target())
        where role_key = 'buyer'),
  '0078''s reader reports an expired grant as not effective');
select is((select revoked_at from public.user_roles where user_id = pg_temp.target() and role_key = 'buyer'),
  null, 'while the row itself was never revoked: expiry and revocation are different things');

-- ---------------------------------------------------------------------------------------------------
-- Revoking is an update, and the row stays (owner decision 5)
-- ---------------------------------------------------------------------------------------------------
select is((select count(*) from public.user_roles where user_id = pg_temp.target() and role_key = 'moderator'),
  1::bigint, 'the target holds the moderator grant from earlier');
select is(pg_temp.revoke_outcome(pg_temp.boss(), true, pg_temp.target(), 'moderator', 'Left the rota'),
  'revoked', 'an administrator revokes it');
select is((select count(*) from public.user_roles where user_id = pg_temp.target() and role_key = 'moderator'),
  1::bigint, 'and the row is still there: a revocation is never a delete');
select ok(
  (select revoked_at is not null from public.user_roles
    where user_id = pg_temp.target() and role_key = 'moderator'),
  'with revoked_at set');
select is(
  (select revoked_by from public.user_roles where user_id = pg_temp.target() and role_key = 'moderator'),
  pg_temp.boss(), 'and revoked_by naming who did it');
select is(
  (select reason from public.user_roles where user_id = pg_temp.target() and role_key = 'moderator'),
  'Left the rota', 'and the reason they gave');
select ok(
  (select granted_at is not null from public.user_roles
    where user_id = pg_temp.target() and role_key = 'moderator'),
  'and the original grant moment still on the row');
select ok(
  (select granted_by is not null from public.user_roles
    where user_id = pg_temp.target() and role_key = 'moderator'),
  'and who granted it');

-- 0078's reader, immediately.
select ok(
  not (select is_effective from app_private.admin_user_roles(pg_temp.boss(), true, pg_temp.target())
        where role_key = 'moderator'),
  '0078''s reader reports it as not effective at once, with no second step');

-- A second revocation is refused rather than overwriting the first.
select is(pg_temp.revoke_outcome(pg_temp.boss(), true, pg_temp.target(), 'moderator', 'Again'),
  'role_already_revoked', 'revoking an already-revoked grant is refused');
select is(
  (select reason from public.user_roles where user_id = pg_temp.target() and role_key = 'moderator'),
  'Left the rota', 'and the first revocation''s reason was not overwritten');

-- Revoking something nobody was granted is an absence, not a state.
select is(pg_temp.revoke_outcome(pg_temp.boss(), true, pg_temp.peer(), 'moderator'), 'not_found',
  'revoking a role the account was never granted is an absence');
select is(pg_temp.revoke_outcome(pg_temp.boss(), true, pg_temp.nobody_at_all(), 'moderator'), 'not_found',
  'and so is one for an account that does not exist');
select is(pg_temp.revoke_outcome(pg_temp.boss(), true, pg_temp.target(), 'wizard'), 'not_found',
  'and a role key that names nothing');
select is(pg_temp.revoke_outcome(pg_temp.boss(), true, pg_temp.target(), null), 'not_found',
  'and no role key at all');
select is(pg_temp.revoke_outcome(pg_temp.moderator(), true, pg_temp.target(), 'seller'), 'not_found',
  'a caller without the key learns nothing from a revocation either');
select is(pg_temp.revoke_outcome(pg_temp.boss(), false, pg_temp.target(), 'seller'), 'not_found',
  'nor one at aal1');
select is(pg_temp.revoke_outcome(null, true, pg_temp.target(), 'seller'), 'not_found', 'nor nobody at all');

-- ---------------------------------------------------------------------------------------------------
-- Revoking: the ceiling applies, and super_admin is beyond this console in both directions
-- ---------------------------------------------------------------------------------------------------
select is(pg_temp.revoke_outcome(pg_temp.boss(), true, pg_temp.super(), 'super_admin'),
  'role_not_revocable', 'an administrator may not strip a super_admin');
select is(pg_temp.revoke_outcome(pg_temp.super(), true, pg_temp.boss(), 'super_admin'),
  'role_not_revocable', 'and a super_admin may not strip one either: not through this console');
select ok(
  (select revoked_at is null from public.user_roles
    where user_id = pg_temp.super() and role_key = 'super_admin'),
  'so the super_admin grant is intact');
select ok(app_private.staff_role_can_manage(pg_temp.super(), true),
  'and the super_admin still holds the key');

-- The ceiling on revocation, with the rota lead as the caller.
select is(pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.peer(), 'support_agent'), 'granted',
  'an administrator grants a support agent role');
select is(pg_temp.revoke_outcome(pg_temp.lead(), true, pg_temp.peer(), 'support_agent'),
  'role_above_ceiling', 'and the rota lead may not take it away: it is above their ceiling');
select ok(
  (select revoked_at is null from public.user_roles
    where user_id = pg_temp.peer() and role_key = 'support_agent'),
  'so it is still held');
select is(pg_temp.revoke_outcome(pg_temp.boss(), true, pg_temp.peer(), 'support_agent', 'No longer needed'),
  'revoked', 'while the administrator may');
select is(pg_temp.revoke_outcome(pg_temp.lead(), true, pg_temp.peer(), 'admin'), 'role_above_ceiling',
  'and the rota lead may not strip an administrator');
select ok(
  (select revoked_at is null from public.user_roles where user_id = pg_temp.peer() and role_key = 'admin'),
  'who still holds it');

-- ---------------------------------------------------------------------------------------------------
-- Reinstatement is an explicit new grant and nothing else (owner decision 5)
-- ---------------------------------------------------------------------------------------------------
select ok(
  (select revoked_at is not null from public.user_roles
    where user_id = pg_temp.target() and role_key = 'moderator'),
  'the moderator grant is revoked');
select is(pg_temp.grant_outcome(pg_temp.peer(), true, pg_temp.target(), 'moderator', 'Back on the rota'),
  'granted', 'a fresh grant reinstates it');
select is(
  (select revoked_at from public.user_roles where user_id = pg_temp.target() and role_key = 'moderator'),
  null, 'revoked_at is cleared');
select is(
  (select revoked_by from public.user_roles where user_id = pg_temp.target() and role_key = 'moderator'),
  null, 'and so is revoked_by');
select is(
  (select granted_by from public.user_roles where user_id = pg_temp.target() and role_key = 'moderator'),
  pg_temp.peer(), 'granted_by names whoever reinstated it, not whoever granted it first');
select is(
  (select reason from public.user_roles where user_id = pg_temp.target() and role_key = 'moderator'),
  'Back on the rota', 'and the reason is the new one');
select ok(
  (select is_effective from app_private.admin_user_roles(pg_temp.boss(), true, pg_temp.target())
    where role_key = 'moderator'),
  'and 0078''s reader reports it effective again');
select is((select count(*) from public.user_roles where user_id = pg_temp.target() and role_key = 'moderator'),
  1::bigint, 'on the same single row: one pairing, one row');

-- There is no operation anywhere that clears a revocation without recording a grant.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.prosrc ~ 'revoked_at\s*=\s*null'),
  1, 'exactly one function in app_private sets revoked_at back to null');
select is(
  (select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.prosrc ~ 'revoked_at\s*=\s*null'),
  'staff_role_grant', 'and it is the grant writer, where a fresh grant is recorded in the same statement');

-- A grant onto a live row refreshes it rather than adding a second.
select is(pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.target(), 'moderator', 'Extended',
                                now() + interval '30 days'),
  'granted', 'granting a role the account already holds is accepted');
select is((select count(*) from public.user_roles where user_id = pg_temp.target() and role_key = 'moderator'),
  1::bigint, 'and still one row');
select ok(
  (select expires_at > now() from public.user_roles
    where user_id = pg_temp.target() and role_key = 'moderator'),
  'with the new expiry, which is the only way to change one');
select is(
  (select reason from public.user_roles where user_id = pg_temp.target() and role_key = 'moderator'),
  'Extended', 'and the new reason');

-- ---------------------------------------------------------------------------------------------------
-- The actor columns are columns, and nothing reports them
-- ---------------------------------------------------------------------------------------------------
select has_column('public', 'user_roles', 'granted_by', '0003''s granted_by column gets its first writer');
select has_column('public', 'user_roles', 'revoked_by', 'and so does revoked_by');
select has_column('public', 'user_roles', 'reason', 'and reason');
select ok(
  (select bool_and(p.prosrc not like '%audit_actor%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'staff_role%'),
  'neither writer names 8-B''s audit channel');

-- Owner decision 8: the read contract does not change.
select is(
  (select count(*)::int from information_schema.parameters
    where specific_schema = 'app_private'
      and specific_name = (select specific_name from information_schema.routines
                            where specific_schema = 'app_private' and routine_name = 'admin_user_roles')
      and parameter_mode = 'OUT'),
  10, '0078''s role reader still returns its ten columns');
select ok(
  (select p.prosrc not like '%granted_by%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'admin_user_roles'),
  'and it still names nobody who granted anything (owner decision 8)');
select ok(
  (select p.prosrc not like '%revoked_by%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'admin_user_roles'),
  'nor anybody who revoked anything');
select ok(
  (select p.prosrc not like '%reason%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'admin_user_roles'),
  'nor the reason either');
select is(
  (select count(*)::int from information_schema.parameters
    where specific_schema = 'app_private'
      and specific_name = (select specific_name from information_schema.routines
                            where specific_schema = 'app_private' and routine_name = 'admin_role_catalogue')
      and parameter_mode = 'OUT'),
  8, 'and 0078''s catalogue still returns its eight');

-- ---------------------------------------------------------------------------------------------------
-- Next-request semantics: the predicates, not a session (owner decision 6)
-- ---------------------------------------------------------------------------------------------------
-- There is nothing in this platform that can end a session, so what "takes effect on the next request" means
-- is that the predicates answer differently the next time they are called. That is testable here directly.
select ok(app_private.staff_role_can_manage(pg_temp.peer(), true),
  'the second administrator holds the manage key');
select ok(app_private.admin_can_read_roles(pg_temp.peer(), true), 'and 0078''s read key');
select is(pg_temp.revoke_outcome(pg_temp.boss(), true, pg_temp.peer(), 'admin', 'Rotated off'), 'revoked',
  'their role is revoked');
select ok(not app_private.staff_role_can_manage(pg_temp.peer(), true),
  'and the manage predicate answers false on the very next call: no second step, no cache');
select ok(not app_private.admin_can_read_roles(pg_temp.peer(), true),
  'and so does 0078''s read predicate');
select is(app_private.staff_role_ceiling(pg_temp.peer(), true), null, 'their ceiling is gone');
select is((select count(*) from app_private.staff_role_grantable(pg_temp.peer(), true)), 0::bigint,
  'and they can grant nothing');
select is(pg_temp.grant_outcome(pg_temp.peer(), true, pg_temp.target(), 'buyer'), 'not_found',
  'a grant they attempt is refused like any other caller without the key');

-- And nothing here pretends to do more than that.
select ok(
  (select bool_and(p.prosrc !~* 'session|sign_?out|logout|jwt|refresh_token')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'staff_role%'),
  'neither writer names a session, a sign-out or a token: no session is ended anywhere here');

select is(pg_temp.grant_outcome(pg_temp.boss(), true, pg_temp.peer(), 'admin', 'Rotated back on'), 'granted',
  'and the administrator is reinstated for the rest of this suite');
select ok(app_private.staff_role_can_manage(pg_temp.peer(), true), 'holding the key again at once');

-- ---------------------------------------------------------------------------------------------------
-- Privilege boundaries: nothing here reaches past roles
-- ---------------------------------------------------------------------------------------------------
select ok(
  (select bool_and(p.prosrc not like '%public.permissions%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'staff_role%'),
  'no function here writes or reads public.permissions');
select ok(
  (select bool_and(p.prosrc !~ 'insert into public\.role_permissions|update public\.role_permissions|delete from public\.role_permissions')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'staff_role%'),
  'and none writes what a role permits');
select ok(
  (select bool_and(p.prosrc !~ 'insert into public\.roles|update public\.roles|delete from public\.roles')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'staff_role%'),
  'nor the role catalogue itself');
select ok(
  (select bool_and(p.prosrc !~* 'seller_profiles|totp|mfa_factor|password|recovery')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'staff_role%'),
  'nor a storefront, a factor, a password or a recovery request');
select ok(
  (select bool_and(p.prosrc !~* 'settlement|payout|balance|payment|ledger|commission')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'staff_role%'),
  'and nothing financial');
select is(
  (select value from public.site_settings where key = 'finance.settlement_posting_enabled'),
  'false', 'the settlement posting flag is still false, untouched');

-- ---------------------------------------------------------------------------------------------------
-- The two writers are the only writers, pinned by name
-- ---------------------------------------------------------------------------------------------------
-- This is what 0078's and 0079's guards become: not "nothing writes this table" but "these two do, and
-- nothing else", which is the stronger statement.
select is(
  (select coalesce(array_agg(p.proname::text order by p.proname), array[]::text[])
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.prosrc ~* 'insert\s+into\s+public\.user_roles'
        or p.prosrc ~* 'update\s+public\.user_roles'
        or p.prosrc ~* 'delete\s+from\s+public\.user_roles')),
  array['staff_role_grant', 'staff_role_revoke'],
  'exactly two app_private functions write public.user_roles, and they are this increment''s');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.prosrc ~* 'delete\s+from\s+public\.user_roles'),
  0, 'and neither of them deletes a row: revocation is an update (owner decision 5)');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'staff_role%'
      and p.prosrc ~* 'insert\s+into\s+public\.user_roles'),
  1, 'one of them inserts');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'staff_role%'
      and p.prosrc ~* 'update\s+public\.user_roles'),
  1, 'and one updates');

rollback;
