-- pgTAP — Phase 7-B: TOTP enrolment and AAL2, as a composition of objects that already existed.
--
-- **This increment adds no database object.** 0004 created `step_up_grants`, 0036 the OTP issuer, 0037
-- the C-19 consumer, 0042 the TOTP issuer, and 0003 the `is_aal2` authorization helpers. 7-B writes the
-- application layer that drives them and nothing else, so the first thing this file does is prove that
-- claim rather than assert it: the inventory, the signatures, the table shape and the privileges are all
-- checked to be exactly what the earlier migrations left.
--
-- What the rest of it holds to account is the composition 7-B depends on, in four groups.
--
-- **The authorization matrix.** Ordinary accounts are not mandatory-TOTP accounts: guest, buyer and
-- seller carry `requires_mfa = false`, so nothing they can do is gated on a second factor. Every staff
-- role carries `requires_mfa = true`, so nothing privileged works at `aal1` — which is the rule 7-B's
-- challenge exists to satisfy and which it leaves exactly as it found it.
--
-- **The grant lifecycle, end to end, for the TOTP source of proof.** Issued, spent once, refused on
-- replay, refused after expiry, refused for another account and refused for another operation. 0042's
-- own file already proves each of these about its writer; what is proved here is that they still hold
-- when the grant is driven the way 7-B drives it, which is the only way a caller will ever meet them.
--
-- **Duplicate consumption cannot be separated from the decision.** Asserted structurally as well as
-- behaviourally: the consumer's body contains exactly one statement that touches the table, so there is
-- no window between checking a grant and spending it for two callers to slip through.
--
-- **There is one way in, and one way to spend.** Two issuers write grants, one per source of proof, and
-- neither lets a caller name the proof it records. There is no third writer and no second consumer.
--
-- Deterministic: fixed uuids, no wall-clock dependence beyond the deliberate expiry fixture. Everything
-- runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(48);

insert into auth.users (id, email) values
  ('7c000000-0000-4000-8000-000000000001', 'totp-staff@test.invalid'),
  ('7c000000-0000-4000-8000-000000000002', 'totp-buyer@test.invalid');

-- ---------------------------------------------------------------------------------------------------
-- Phase 7-B added no database object
-- ---------------------------------------------------------------------------------------------------
select is(
  (select array_to_string(array_agg(p.proname || '/' || p.pronargs order by p.proname), ' ')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like '%step_up%'),
  'consume_step_up_grant/3 issue_step_up_grant/3 issue_totp_step_up_grant/2',
  'the step-up functions are the three that already existed: 7-B added none and replaced none');

select is(
  (select array_to_string(p.proargnames[1:p.pronargs], ' ')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'issue_totp_step_up_grant'),
  'p_user_id p_operation',
  'the TOTP issuer still takes an account and an operation, and nothing that could name the proof');

select is(
  (select array_to_string(p.proargnames[1:p.pronargs], ' ')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'consume_step_up_grant'),
  'p_grant_id p_user_id p_operation',
  'and the C-19 consumer still takes a grant, an account and an operation');

select is(
  (select array_to_string(array_agg(c.column_name order by c.ordinal_position), ' ')
     from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'step_up_grants'),
  'id user_id operation granted_via challenge_id granted_at expires_at consumed_at',
  'the grant table has the columns 0004 and 0036 gave it, in their order, and no new one');

select is(
  (select count(*) from pg_tables t
    where t.schemaname in ('public', 'app_private')
      and (t.tablename like '%totp%' or t.tablename like '%mfa%' or t.tablename like '%factor%'
        or t.tablename like '%authenticator%')),
  0::bigint,
  'no TOTP, MFA, factor or authenticator table exists: the secret lives with the identity provider');

select is(
  (select count(*) from information_schema.role_table_grants
    where table_name = 'step_up_grants'
      and grantee in ('app_api', 'app_system', 'app_worker', 'anon')),
  0::bigint,
  'no login role holds a table privilege on the grants: every write is through a named function');

select ok(has_function_privilege('app_system', 'app_private.issue_totp_step_up_grant(uuid, text)', 'execute'),
  'app_system may issue a TOTP grant');
select ok(not has_function_privilege('authenticated', 'app_private.issue_totp_step_up_grant(uuid, text)', 'execute'),
  'and authenticated may not: a browser that could would mint its own authorisation');
select ok(not has_function_privilege('authenticated', 'app_private.consume_step_up_grant(uuid, uuid, text)', 'execute'),
  'nor may it spend one');
select ok(not has_function_privilege('anon', 'app_private.issue_totp_step_up_grant(uuid, text)', 'execute'),
  'and neither may anon');

select lives_ok($$ select app_private.assert_security_contract() $$,
  'the deploy-time security contract still holds');

-- ---------------------------------------------------------------------------------------------------
-- Ordinary accounts are not mandatory-TOTP accounts
-- ---------------------------------------------------------------------------------------------------
select is(
  (select array_to_string(array_agg(r.key order by r.sort_order), ' ')
     from public.roles r where not r.requires_mfa),
  'guest buyer seller',
  'guest, buyer and seller require no second factor: 7-B makes 2FA mandatory for nobody');

select is(
  (select array_to_string(array_agg(r.key order by r.sort_order), ' ')
     from public.roles r where r.requires_mfa),
  'moderator support_agent admin super_admin',
  'and every staff role does, which is the rule the TOTP challenge exists to satisfy');

select is(
  (select count(*) from public.roles r where r.is_admin_console and not r.requires_mfa),
  0::bigint,
  'no console role can exist without requiring MFA — the 0003 CHECK, still in force');

select is(
  (select count(*) from public.roles r where not r.is_admin_console and r.requires_mfa),
  0::bigint,
  'and no non-console role requires it, so a buyer is never asked for a second factor');

-- ---------------------------------------------------------------------------------------------------
-- Staff need aal2; buyers and sellers are unaffected by it
-- ---------------------------------------------------------------------------------------------------
insert into public.user_roles (user_id, role_key) values
  ('7c000000-0000-4000-8000-000000000001', 'admin'),
  ('7c000000-0000-4000-8000-000000000002', 'buyer');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"7c000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);
create temp table staff_aal1 as
select public.is_aal2() as aal2,
       public.has_role('admin') as admin_role,
       public.has_permission('users.role.manage') as can_manage_roles;
reset role;

select ok((select not aal2 from staff_aal1), 'a staff session before the TOTP challenge is not aal2');
select ok((select not admin_role from staff_aal1),
  'so the admin role is inactive: signing in with a password alone is not staff access');
select ok((select not can_manage_roles from staff_aal1),
  'and no privileged permission applies, which is what "nothing privileged at aal1" means');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"7c000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}', true);
create temp table staff_aal2 as
select public.is_aal2() as aal2,
       public.has_role('admin') as admin_role,
       public.has_permission('users.role.manage') as can_manage_roles;
reset role;

select ok((select aal2 from staff_aal2),
  'the session the provider mints for a satisfied challenge is aal2');
select ok((select admin_role from staff_aal2), 'which activates the staff role');
select ok((select can_manage_roles from staff_aal2), 'and its privileged permissions');

-- A buyer is untouched by all of it, at either assurance level.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"7c000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}', true);
create temp table buyer_aal1 as
select public.has_role('buyer') as buyer_role,
       public.has_role('admin') as admin_role,
       public.has_permission('users.role.manage') as can_manage_roles;
reset role;

select ok((select buyer_role from buyer_aal1),
  'a buyer holds their role at aal1: no second factor is required of them');
select ok((select not admin_role from buyer_aal1),
  'a buyer does not hold a staff role, whatever their assurance level');
select ok((select not can_manage_roles from buyer_aal1),
  'and holds no staff permission');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"7c000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}', true);
create temp table buyer_aal2 as
select public.has_role('admin') as admin_role,
       public.has_permission('users.role.manage') as can_manage_roles;
reset role;

select ok((select not admin_role from buyer_aal2),
  'and reaching aal2 gives a buyer no staff role: a second factor is not a promotion');
select ok((select not can_manage_roles from buyer_aal2),
  'nor any staff permission — the role assignment decides that, and aal2 only gates it');

-- ---------------------------------------------------------------------------------------------------
-- The grant lifecycle, driven the way Phase 7-B drives it
-- ---------------------------------------------------------------------------------------------------
create temporary table granted on commit drop as
  select * from app_private.issue_totp_step_up_grant(
    '7c000000-0000-4000-8000-000000000001', 'payout.details.change');

select is((select outcome from granted), 'granted',
  'a satisfied TOTP challenge records a grant for the account and operation it names');
select isnt((select grant_id from granted), null, 'and hands back its identifier');

select is(
  (select g.granted_via from public.step_up_grants g where g.id = (select grant_id from granted)),
  'totp',
  'recorded as totp, which is a literal inside the function and not a caller''s to choose');
select is(
  (select g.challenge_id from public.step_up_grants g where g.id = (select grant_id from granted)),
  null::uuid,
  'with no challenge id, because a TOTP verification leaves no OTP challenge row');
select ok(
  (select g.expires_at - g.granted_at from public.step_up_grants g
    where g.id = (select grant_id from granted)) = interval '10 minutes',
  'and C-16''s ten minutes, likewise fixed inside the function');

-- Unauthorized use: the wrong account and the wrong operation, before the right one.
select ok(
  not app_private.consume_step_up_grant(
    (select grant_id from granted), '7c000000-0000-4000-8000-000000000002', 'payout.details.change'),
  'a buyer cannot spend a staff member''s grant');
select ok(
  not app_private.consume_step_up_grant(
    (select grant_id from granted), '7c000000-0000-4000-8000-000000000001', 'account.delete'),
  'and the grant authorises only the operation it was issued for');
select is(
  (select g.consumed_at from public.step_up_grants g where g.id = (select grant_id from granted)),
  null::timestamptz,
  'neither refusal spent it — merely checking a grant consumes nothing (C-19 rule 3)');

select ok(
  app_private.consume_step_up_grant(
    (select grant_id from granted), '7c000000-0000-4000-8000-000000000001', 'payout.details.change'),
  'its own account and operation spend it');
select isnt(
  (select g.consumed_at from public.step_up_grants g where g.id = (select grant_id from granted)),
  null::timestamptz, 'which marks it consumed');

-- Replay, three ways.
select ok(
  not app_private.consume_step_up_grant(
    (select grant_id from granted), '7c000000-0000-4000-8000-000000000001', 'payout.details.change'),
  'replaying the same grant authorises nothing: it is single-use');
select ok(
  not app_private.consume_step_up_grant(
    (select grant_id from granted), '7c000000-0000-4000-8000-000000000001', 'payout.details.change'),
  'and stays spent however many times it is tried');
select is(
  (select count(*) from public.step_up_grants g
    where g.id = (select grant_id from granted) and g.consumed_at is not null),
  1::bigint,
  'one consumption, recorded once: a replay writes nothing new');

-- A grant that never existed, and one belonging to nobody.
select ok(
  not app_private.consume_step_up_grant(
    '7d000000-0000-4000-8000-0000000000ff', '7c000000-0000-4000-8000-000000000001', 'payout.details.change'),
  'a grant identifier that was never issued authorises nothing');

-- Expiry.
create temporary table stale on commit drop as
  select * from app_private.issue_totp_step_up_grant(
    '7c000000-0000-4000-8000-000000000001', 'sessions.revoke_all');
update public.step_up_grants
   set granted_at = now() - interval '20 minutes', expires_at = now() - interval '1 second'
 where id = (select grant_id from stale);

select ok(
  not app_private.consume_step_up_grant(
    (select grant_id from stale), '7c000000-0000-4000-8000-000000000001', 'sessions.revoke_all'),
  'a TOTP grant past its ten minutes authorises nothing, however correct the code that made it was');
select is(
  (select g.consumed_at from public.step_up_grants g where g.id = (select grant_id from stale)),
  null::timestamptz,
  'and an expired grant is not even marked spent: there was nothing to spend');

-- ---------------------------------------------------------------------------------------------------
-- Duplicate consumption cannot be separated from the decision
-- ---------------------------------------------------------------------------------------------------
-- Behaviour above shows a second attempt fails. This shows *why* it must, for concurrent callers too:
-- the consumer decides and writes in one statement, so there is no moment at which two callers could
-- both have decided before either had written.
select is(
  (select count(*)
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace,
     lateral regexp_matches(
       regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), 'update\s+public\.step_up_grants', 'gi')
    where n.nspname = 'app_private' and p.proname = 'consume_step_up_grant'),
  1::bigint,
  'the consumer touches the grant table in exactly one UPDATE');
select is(
  (select count(*)
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace,
     lateral regexp_matches(
       regexp_replace(p.prosrc, '--[^\n]*', '', 'g'),
       'select\s+[^;]*from\s+public\.step_up_grants', 'gi')
    where n.nspname = 'app_private' and p.proname = 'consume_step_up_grant'),
  0::bigint,
  'and never reads the row first: the check is the consumption, not a step before it');

-- ---------------------------------------------------------------------------------------------------
-- One way in, one way to spend
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.prosrc ~* 'insert\s+into\s+public\.step_up_grants'),
  2::bigint,
  'exactly two functions write grants: one per source of proof F5 names, and no third');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
     unnest(p.proargnames[1:p.pronargs]) as arg
    where n.nspname = 'app_private'
      and p.prosrc ~* 'insert\s+into\s+public\.step_up_grants'
      and arg in ('p_granted_via', 'p_via', 'p_expires_at', 'p_validity', 'p_duration')),
  0::bigint,
  'and neither takes the proof or the validity as a parameter: both are literals a caller cannot reach');

select is(
  (select count(*) from public.step_up_grants g where g.granted_via = 'totp' and g.challenge_id is not null),
  0::bigint,
  'no TOTP grant carries a challenge id, so the 0036 partial unique index never applies to one');
select is(
  (select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'public.step_up_grants'::regclass and conname = 'step_up_grants_via_allowed'),
  'CHECK ((granted_via = ANY (ARRAY[''totp''::text, ''otp_email''::text, ''otp_sms''::text, ''otp_whatsapp''::text])))',
  'the approved sources of proof are unchanged: 7-B added none');

select * from finish();
rollback;
