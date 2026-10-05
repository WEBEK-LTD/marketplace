-- pgTAP — migration 0068: the staff console access reader (Phase 7-F).
--
-- One function, so the assertions are about what it answers rather than about what it built. They fall
-- into five groups.
--
-- **The boundary.** SECURITY DEFINER with a pinned search path, executable by `app_system` and by
-- nobody else. That matters more here than almost anywhere: the function takes an account **and an
-- assurance level** as parameters, so a role that could call it while choosing both would be a role that
-- could read any staff member's permissions and assert its own second factor.
--
-- **Nothing privileged at aal1.** Every privileged role carries `requires_mfa`, and at aal1 this reader
-- returns empty sets for all four of them — the authorization matrix's rule, asserted per role rather
-- than once, because "the admin is special" is exactly the assumption that would let one through.
--
-- **The rule is 0003's, not a second copy.** For every staff role and every permission that role holds,
-- the reader's answer at aal2 is checked against `public.role_permissions` itself, so a divergence
-- between this function and the assignments it reads would fail here rather than in a console.
--
-- **It reads one account.** Two staff members with different roles exist throughout; each query is
-- checked to return that member's own sets and never the other's.
--
-- **It cannot write.** Asserted structurally — `language sql` with `provolatile = 's'` — and
-- behaviourally: the role assignments are counted before and after.
--
-- Deterministic: fixed uuids, no wall-clock dependence beyond the deliberate expiry fixture. Everything
-- runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(55);

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('7f000000-0000-4000-8000-000000000001', 'staff-admin@test.invalid'),
  ('7f000000-0000-4000-8000-000000000002', 'staff-moderator@test.invalid'),
  ('7f000000-0000-4000-8000-000000000003', 'staff-support@test.invalid'),
  ('7f000000-0000-4000-8000-000000000004', 'staff-super@test.invalid'),
  ('7f000000-0000-4000-8000-000000000005', 'plain-buyer@test.invalid'),
  ('7f000000-0000-4000-8000-000000000006', 'plain-seller@test.invalid'),
  ('7f000000-0000-4000-8000-000000000007', 'revoked-admin@test.invalid'),
  ('7f000000-0000-4000-8000-000000000008', 'expired-admin@test.invalid');

insert into public.user_roles (user_id, role_key, granted_at, expires_at, revoked_at) values
  ('7f000000-0000-4000-8000-000000000001', 'admin',         now() - interval '1 day', null, null),
  ('7f000000-0000-4000-8000-000000000002', 'moderator',     now() - interval '1 day', null, null),
  ('7f000000-0000-4000-8000-000000000003', 'support_agent', now() - interval '1 day', null, null),
  ('7f000000-0000-4000-8000-000000000004', 'super_admin',   now() - interval '1 day', null, null),
  ('7f000000-0000-4000-8000-000000000005', 'buyer',         now() - interval '1 day', null, null),
  ('7f000000-0000-4000-8000-000000000006', 'seller',        now() - interval '1 day', null, null),
  ('7f000000-0000-4000-8000-000000000007', 'admin',         now() - interval '1 day', null, now() - interval '1 hour'),
  ('7f000000-0000-4000-8000-000000000008', 'admin',         now() - interval '2 days', now() - interval '1 hour', null);

create temp table role_baseline as select count(*) as n from public.user_roles;

-- ---------------------------------------------------------------------------------------------------
-- The boundary
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'staff_console_access', array['uuid', 'boolean'],
  'the reader exists with the signature the API calls');
select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'staff_console_access'),
  'SECURITY DEFINER with a pinned search path'
);
select is(
  (select p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'staff_console_access'),
  's'::"char",
  'and stable, so it cannot write: no grant, no promotion, no assignment is even expressible'
);
select is(
  (select l.lanname from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     join pg_language l on l.oid = p.prolang
    where n.nspname = 'app_private' and p.proname = 'staff_console_access'),
  'sql',
  'written in plain SQL rather than a procedural language'
);
select ok(
  has_function_privilege('app_system', 'app_private.staff_console_access(uuid, boolean)', 'execute'),
  'app_system may call it'
);
select is(
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'staff_console_access'
      and (has_function_privilege('authenticated', p.oid, 'execute')
        or has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('app_worker', p.oid, 'execute')
        or has_function_privilege('app_api', p.oid, 'execute'))),
  0::bigint,
  'and nobody else may: it takes an account and an assurance level, so a caller that chose both could read anything'
);

-- 0003's three helpers are untouched and still belong to the session-bearing caller.
select ok(has_function_privilege('authenticated', 'public.has_permission(text)', 'execute'),
  'authenticated keeps 0003''s has_permission');
select ok(has_function_privilege('authenticated', 'public.is_aal2()', 'execute'),
  'and 0003''s is_aal2');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('has_permission', 'has_role', 'is_aal2')
      and p.prosrc like '%jwt_claims%' or (n.nspname = 'public' and p.proname in ('has_permission', 'has_role')
      and p.prosrc like '%current_user_id%')),
  3::bigint,
  'and all three still resolve their caller from the session, which is why this one exists'
);

-- ---------------------------------------------------------------------------------------------------
-- Nothing privileged at aal1
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from public.roles where is_admin_console and not requires_mfa),
  0::bigint,
  'every console role requires MFA, which is the constraint 0003 declares'
);

select ok(
  (select a.has_console_role from app_private.staff_console_access('7f000000-0000-4000-8000-000000000001', false) a),
  'an admin at aal1 is still recognised as staff, so the console can send them to the challenge'
);
select ok(
  (select a.requires_step_up from app_private.staff_console_access('7f000000-0000-4000-8000-000000000001', false) a),
  'and is told a step-up is what is missing'
);
select is(
  (select a.permissions from app_private.staff_console_access('7f000000-0000-4000-8000-000000000001', false) a),
  array[]::text[],
  'while holding no permission at all at aal1'
);
select is(
  (select a.roles from app_private.staff_console_access('7f000000-0000-4000-8000-000000000001', false) a),
  array[]::text[],
  'and no effective role'
);

select is(
  (select a.permissions from app_private.staff_console_access('7f000000-0000-4000-8000-000000000002', false) a),
  array[]::text[],
  'a moderator at aal1 holds nothing'
);
select is(
  (select a.permissions from app_private.staff_console_access('7f000000-0000-4000-8000-000000000003', false) a),
  array[]::text[],
  'a support agent at aal1 holds nothing'
);
select is(
  (select a.permissions from app_private.staff_console_access('7f000000-0000-4000-8000-000000000004', false) a),
  array[]::text[],
  'and a super admin at aal1 holds nothing: there is no role this rule exempts'
);
select is(
  (select a.permissions from app_private.staff_console_access('7f000000-0000-4000-8000-000000000001', null) a),
  array[]::text[],
  'an absent assurance level is treated as aal1, never as permission'
);

-- ---------------------------------------------------------------------------------------------------
-- At aal2, the answer is the assignment table's own
-- ---------------------------------------------------------------------------------------------------
select ok(
  not (select a.requires_step_up from app_private.staff_console_access('7f000000-0000-4000-8000-000000000001', true) a),
  'an admin at aal2 needs no step-up'
);
select is(
  (select a.roles from app_private.staff_console_access('7f000000-0000-4000-8000-000000000001', true) a),
  array['admin'],
  'and holds exactly the role they were assigned'
);
select is(
  (select a.permissions from app_private.staff_console_access('7f000000-0000-4000-8000-000000000001', true) a),
  (select array_agg(distinct rp.permission_key order by rp.permission_key)
     from public.role_permissions rp where rp.role_key = 'admin'),
  'and exactly the permissions role_permissions assigns that role, no more and no fewer'
);
select is(
  (select a.permissions from app_private.staff_console_access('7f000000-0000-4000-8000-000000000002', true) a),
  (select array_agg(distinct rp.permission_key order by rp.permission_key)
     from public.role_permissions rp where rp.role_key = 'moderator'),
  'a moderator at aal2 holds the moderator set'
);
select is(
  (select a.permissions from app_private.staff_console_access('7f000000-0000-4000-8000-000000000003', true) a),
  (select array_agg(distinct rp.permission_key order by rp.permission_key)
     from public.role_permissions rp where rp.role_key = 'support_agent'),
  'a support agent at aal2 holds the support set'
);
select is(
  (select a.permissions from app_private.staff_console_access('7f000000-0000-4000-8000-000000000004', true) a),
  (select array_agg(distinct rp.permission_key order by rp.permission_key)
     from public.role_permissions rp where rp.role_key = 'super_admin'),
  'and a super admin at aal2 holds the super admin set'
);

-- The sets genuinely differ, so a shell driven by them cannot show one role another's sections.
select ok(
  not (select a.permissions from app_private.staff_console_access('7f000000-0000-4000-8000-000000000003', true) a)
      @> array['moderation.report.manage'],
  'a support agent does not hold a moderation permission'
);
select ok(
  not (select a.permissions from app_private.staff_console_access('7f000000-0000-4000-8000-000000000002', true) a)
      @> array['support.ticket.read'],
  'and a moderator does not hold a support permission'
);
select ok(
  (select a.permissions from app_private.staff_console_access('7f000000-0000-4000-8000-000000000003', true) a)
    @> array['support.ticket.read', 'security.recovery.review'],
  'a support agent holds the two they were assigned'
);
select ok(
  (select a.permissions from app_private.staff_console_access('7f000000-0000-4000-8000-000000000002', true) a)
    @> array['moderation.report.read', 'reviews.review.moderate', 'catalog.listing.read'],
  'and a moderator holds theirs'
);
select ok(
  not (select a.permissions from app_private.staff_console_access('7f000000-0000-4000-8000-000000000002', true) a)
      @> array['users.role.manage'],
  'neither of them can manage roles'
);
select ok(
  (select a.permissions from app_private.staff_console_access('7f000000-0000-4000-8000-000000000001', true) a)
    @> array['users.role.manage', 'audit.read', 'platform.job.read'],
  'and an admin holds the three the shell gates its own sensitive sections on'
);

-- ---------------------------------------------------------------------------------------------------
-- Accounts that are not staff
-- ---------------------------------------------------------------------------------------------------
select ok(
  not (select a.has_console_role from app_private.staff_console_access('7f000000-0000-4000-8000-000000000005', true) a),
  'a buyer is not console staff, even with an aal2 session'
);
select is(
  (select a.permissions from app_private.staff_console_access('7f000000-0000-4000-8000-000000000005', true) a),
  array[]::text[],
  'and holds no console permission'
);
select ok(
  not (select a.requires_step_up from app_private.staff_console_access('7f000000-0000-4000-8000-000000000005', false) a),
  'and is never told to step up: there is nothing behind it for them'
);
select ok(
  not (select a.has_console_role from app_private.staff_console_access('7f000000-0000-4000-8000-000000000006', true) a),
  'a seller is not console staff either'
);
select is(
  (select a.permissions from app_private.staff_console_access('7f000000-0000-4000-8000-000000000006', true) a),
  array[]::text[],
  'and holds no console permission'
);
select is(
  (select a.roles from app_private.staff_console_access('7f000000-0000-4000-8000-000000000005', true) a),
  array['buyer'],
  'their own ordinary role is still reported, because it is theirs and carries no MFA requirement'
);
select is(
  (select count(*) from app_private.staff_console_access('7f000000-0000-4000-8000-0000000000ff', true)),
  1::bigint,
  'an account that does not exist answers one row rather than none'
);
select ok(
  not (select a.has_console_role from app_private.staff_console_access('7f000000-0000-4000-8000-0000000000ff', true) a),
  'and that row is staff of nothing'
);
select is(
  (select a.permissions from app_private.staff_console_access('7f000000-0000-4000-8000-0000000000ff', true) a),
  array[]::text[],
  'holding nothing'
);
select is(
  (select count(*) from app_private.staff_console_access(null, true)),
  1::bigint,
  'and a null account answers the same empty row rather than erroring'
);
select ok(
  not (select a.has_console_role from app_private.staff_console_access(null, true) a),
  'which is staff of nothing too'
);

-- ---------------------------------------------------------------------------------------------------
-- A role that is no longer in force
-- ---------------------------------------------------------------------------------------------------
select ok(
  not (select a.has_console_role from app_private.staff_console_access('7f000000-0000-4000-8000-000000000007', true) a),
  'a revoked admin is not staff'
);
select is(
  (select a.permissions from app_private.staff_console_access('7f000000-0000-4000-8000-000000000007', true) a),
  array[]::text[],
  'and holds nothing, aal2 or not'
);
select ok(
  not (select a.has_console_role from app_private.staff_console_access('7f000000-0000-4000-8000-000000000008', true) a),
  'an expired admin grant is not staff'
);
select is(
  (select a.permissions from app_private.staff_console_access('7f000000-0000-4000-8000-000000000008', true) a),
  array[]::text[],
  'and holds nothing either'
);

-- ---------------------------------------------------------------------------------------------------
-- One account at a time
-- ---------------------------------------------------------------------------------------------------
select ok(
  not (select a.roles from app_private.staff_console_access('7f000000-0000-4000-8000-000000000002', true) a)
      @> array['admin'],
  'asking about the moderator never returns the admin''s role'
);
select ok(
  not (select a.permissions from app_private.staff_console_access('7f000000-0000-4000-8000-000000000003', true) a)
      @> array['settings.site.manage'],
  'nor the admin''s permissions'
);
select is(
  (select count(*) from app_private.staff_console_access('7f000000-0000-4000-8000-000000000001', true)),
  1::bigint,
  'and every call answers exactly one row, so there is no shape in which two accounts could be merged'
);

-- ---------------------------------------------------------------------------------------------------
-- Nothing moved
-- ---------------------------------------------------------------------------------------------------
select is((select count(*) from public.user_roles), (select n from role_baseline),
  'reading permissions assigned nobody a role');
select is(
  (select count(*) from public.roles where key in ('support_agent', 'moderator', 'admin', 'super_admin')),
  4::bigint,
  'the four staff roles are the four that existed; 7-F adds none'
);
select is(
  (select count(*) from public.roles),
  7::bigint,
  'and the role set as a whole is unchanged'
);
select is(
  (select count(*) from public.role_permissions where role_key = 'support_agent'),
  5::bigint,
  'the support agent''s assignments are untouched'
);
select is(
  (select count(*) from public.role_permissions where role_key = 'moderator'),
  9::bigint,
  'and the moderator''s'
);
select is(
  (select count(*) from public.step_up_grants),
  0::bigint,
  'reading permissions issued no step-up grant: this reader is not a second way to reach aal2'
);
select is(
  (select count(*) from public.security_events),
  0::bigint,
  'and recorded no security event of its own'
);

select finish();
rollback;
