-- 0100 — Staff role assignment and revocation: the writer 0078 recorded as missing, with its ceiling in the database.
--
-- `public.user_roles` has been written by nothing in this repository since 0003 created it. 0078 recorded that
-- gap in full, enumerated the questions a writer would have to answer, and closed with the owner decision that
-- role assignment is "deferred to a dedicated security-focused increment after Phase 7". This is that
-- increment, and every question is answered by an owner decision rather than by this file.
--
-- **THE CEILING IS THE WHOLE POINT, AND IT IS COMPUTED HERE.**
--
-- A role manager may never grant a role whose `sort_order` is above their own highest *effective* role, and
-- `super_admin` is not grantable through this console at all — so `admin` (6) is the ceiling of the ceiling.
-- Both tests are applied inside the writer, against `public.roles` and `public.user_roles` as they stand at
-- the moment of the write. The grantable set is also *read* from the database, by `staff_role_grantable`, so a
-- console offers exactly what the writer would accept; a console that merely hid the rest would be a UI
-- convention, and this is a privilege boundary.
--
-- `roles.is_assignable` gets its first reader here. 0003 put the column there, 0033 seeds it false for `guest`
-- alone, and 0078's catalogue reports it — nothing has ever acted on it, because nothing has ever assigned.
--
-- **WHAT "EFFECTIVE" MEANS IS 0003'S RULE, NOT A NEW ONE.** A grant counts when it is not revoked and not
-- expired, and a role that requires MFA counts for nothing at `aal1` — the same three conjuncts every
-- permission predicate in this repository already applies, with the assurance level as a parameter. The
-- ceiling is read through that rule, so a manager at `aal1` has no ceiling at all and can grant nothing;
-- `users.role.manage` is held only by `admin` and `super_admin`, both `requires_mfa` in 0033, so the key check
-- refuses them there first anyway. Two independent reasons for the same refusal is the intent.
--
-- **REVOCATION IS AN UPDATE, NEVER A DELETE.** `revoked_at` and `revoked_by` are set and the row stays, so the
-- history of a grant survives its withdrawal. Reinstatement is a fresh grant through the grant writer — there
-- is no operation anywhere in this increment that clears `revoked_at` on its own. The grant writer restores a
-- revoked row by giving it a new `granted_at`, a new `granted_by` and a new `reason`, which is what a new grant
-- of the same role is.
--
-- **THE CEILING APPLIES TO REVOCATION TOO. THIS IS AN APPROVED OWNER DECISION, NOT A READING.**
--
-- The decision list that opened this increment set the ceiling for granting and was silent on withdrawing.
-- The question was raised on delivery and the owner confirmed the rule explicitly, so it is part of 0100's
-- final contract rather than an implementer's judgement:
--
--   * the role ceiling applies to revocation exactly as it applies to granting;
--   * `super_admin` cannot be revoked through this staff role-management console;
--   * **no** role-management operation may remove a role above the caller's effective ceiling;
--   * `STAFF_ROLE_NOT_REVOCABLE` and this fail-closed behaviour are to be kept.
--
-- So allowing an `admin` to strip a `super_admin` — an escalation by removal — is refused, and `super_admin`
-- is no more revocable here than it is grantable: this console can neither create nor destroy one. That keeps
-- the role a database-level operation in both directions and removes any path to a last-`super_admin` lockout
-- from a web request. Loosening any part of it now needs a new owner decision, not a code change.
--
-- **ATTRIBUTION IS TWO COLUMNS, AND 8-B'S CHANNEL IS NOT NAMED.** `granted_by` and `revoked_by` are written
-- from the caller's own account. `public.audit_attribution_problems()` fails any function that names 8-B's
-- channel without being in its approved financial contract, so neither writer here names it. `public.user_roles`
-- carries no audit trigger — 0003 gave it only `user_roles_set_updated_at`, and this migration does not add one,
-- because adding a trigger to a closed increment's table is not this increment's business. The two actor
-- columns, `reason` and `updated_at` are the record, and owner decision 8 keeps all of them out of the read
-- contract: `admin_user_roles` is not touched, so nothing above this migration reports who granted what.
--
-- **NO SESSION IS ENDED.** Nothing in this platform can terminate a session — there is no revocation
-- primitive anywhere, and 0043 records that reading `auth.sessions` needs its columns established by live
-- observation under C-14 first. So a revocation takes effect when the permission predicates are next
-- evaluated, which is the target's next request. The console says that in words rather than implying a
-- lockout it cannot deliver.
--
-- **WHAT IS NOT HERE.** No change to `roles`, `permissions` or `role_permissions` — the catalogue is 0033's and
-- this increment only reads it. No new permission key: `users.role.manage` has been seeded since 0033 and
-- reachable by nothing. No session termination, no impersonation, no password, TOTP or recovery change, no
-- seller status change, no change to any read surface 0078 or 0079 shipped, and nothing on any financial path.

-- ---------------------------------------------------------------------------------------------------
-- 1. The permission predicate
-- ---------------------------------------------------------------------------------------------------
-- `users.role.manage` as a literal, with 0003's own `requires_mfa` rule applied to the assurance level as a
-- parameter. The same shape as every predicate in 0078, and no role name is tested anywhere.
create or replace function app_private.staff_role_can_manage(
  p_user_id uuid,
  p_is_aal2 boolean
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.user_roles ur
      join public.roles r on r.key = ur.role_key
      join public.role_permissions rp on rp.role_key = r.key
     where ur.user_id = p_user_id
       and ur.revoked_at is null
       and (ur.expires_at is null or ur.expires_at > now())
       and rp.permission_key = 'users.role.manage'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.staff_role_can_manage(uuid, boolean) is
  'Whether one account effectively holds users.role.manage — the key 0033 has seeded since the beginning and that nothing could reach until this migration. 0003''s own effectiveness rule, with the assurance level as a parameter and the key as a literal. No role name is tested.';

-- ---------------------------------------------------------------------------------------------------
-- 2. The ceiling
-- ---------------------------------------------------------------------------------------------------
-- The highest `sort_order` this caller effectively holds, or null when they hold nothing that counts. Null is
-- the fail-closed answer: every comparison against it is false, so a caller with no effective role grants
-- nothing even if the key check were somehow satisfied.
create or replace function app_private.staff_role_ceiling(
  p_user_id uuid,
  p_is_aal2 boolean
) returns integer
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select max(r.sort_order)
    from public.user_roles ur
    join public.roles r on r.key = ur.role_key
   where ur.user_id = p_user_id
     and ur.revoked_at is null
     and (ur.expires_at is null or ur.expires_at > now())
     and (not r.requires_mfa or coalesce(p_is_aal2, false));
$$;

comment on function app_private.staff_role_ceiling(uuid, boolean) is
  'The sort_order of the highest role one account effectively holds, under 0003''s own rule, or null when it holds none that count. This is the grant ceiling: a manager may never grant above it. Null fails closed, because every comparison against null is false.';

-- ---------------------------------------------------------------------------------------------------
-- 3. The grantable set, read from the database
-- ---------------------------------------------------------------------------------------------------
-- Exactly the roles the writer below would accept from this caller, so a console offers no control that is
-- then refused and hides no control that would be allowed. No row at all for a caller who does not hold
-- `users.role.manage` at the required assurance level: an empty set and a refusal look alike, as they do on
-- every read in 0078.
--
-- `super_admin` is excluded by key, not by its position, so a later change to `sort_order` cannot make it
-- grantable by accident.
create or replace function app_private.staff_role_grantable(
  p_user_id uuid,
  p_is_aal2 boolean
) returns table (
  role_key text,
  name_en text,
  name_ar text,
  requires_mfa boolean,
  is_admin_console boolean,
  sort_order integer
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select r.key, r.name_en, r.name_ar, r.requires_mfa, r.is_admin_console, r.sort_order
    from public.roles r
   where app_private.staff_role_can_manage(p_user_id, p_is_aal2)
     and r.is_assignable
     and r.key <> 'super_admin'
     and r.sort_order <= app_private.staff_role_ceiling(p_user_id, p_is_aal2)
   order by r.sort_order, r.key;
$$;

comment on function app_private.staff_role_grantable(uuid, boolean) is
  'The roles this caller may grant: assignable, never super_admin, and never above their own effective ceiling. The same three tests the grant writer applies, so a console offers exactly what would be accepted. No row for a caller without users.role.manage, so an empty set and a refusal are indistinguishable.';

-- ---------------------------------------------------------------------------------------------------
-- 4. Granting
-- ---------------------------------------------------------------------------------------------------
-- Outcomes, in the order they are decided:
--
--   `not_found`             — no caller, no target, no role key, the key not held, a target account that does
--                             not exist, or a role key that names no role. One answer for an absence and for a
--                             missing permission, which is how every surface in this console behaves.
--   `role_is_self`          — the caller is the target. Refused for granting and for revoking alike.
--   `role_reason_required`  — a blank reason. The contract refuses it first; this is the floor.
--   `role_not_assignable`   — `roles.is_assignable` is false. Its first reader.
--   `role_not_grantable`    — `super_admin`, which this console never grants whatever the caller holds.
--   `role_above_ceiling`    — above the caller's own highest effective role, or the caller has none.
--   `role_expiry_invalid`   — an expiry that is not in the future, which 0003's own constraint would refuse.
--   `granted`               — written.
--
-- A grant onto a row that already exists is an update: it refreshes `granted_at`, `granted_by`, `reason` and
-- `expires_at`, and clears `revoked_at` and `revoked_by`. That is both the reinstatement of a revoked grant
-- (owner decision 5) and the only way to change an expiry (owner decision 4). The primary key is
-- `(user_id, role_key)`, so there is one row per pairing and its history lives in the audit of its changes.
create or replace function app_private.staff_role_grant(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_target_user_id uuid,
  p_role_key text,
  p_reason text,
  p_expires_at timestamptz default null
) returns table (
  outcome text,
  role_key text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  -- `btrim` with no character set trims spaces only, so a reason of tabs and newlines would survive it and be
  -- stored as though somebody had written one. The set is named explicitly, as 0096 does for the same reason.
  v_reason text := nullif(btrim(coalesce(p_reason, ''), E' \t\r\n'), '');
  v_key text := nullif(btrim(coalesce(p_role_key, ''), E' \t\r\n'), '');
  v_sort_order integer;
  v_is_assignable boolean;
  v_ceiling integer;
begin
  if p_user_id is null or p_target_user_id is null or v_key is null
     or not app_private.staff_role_can_manage(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- Owner decision 2. Before anything else that could be read as progress: a colleague may not give
  -- themselves a role, whatever the role is and whatever they already hold.
  if p_user_id = p_target_user_id then
    return query select 'role_is_self'::text, null::text;
    return;
  end if;

  -- Owner decision 7.
  if v_reason is null then
    return query select 'role_reason_required'::text, null::text;
    return;
  end if;

  -- An account that is not there is an absence, like a role key that names nothing.
  if not exists (select 1 from auth.users u where u.id = p_target_user_id) then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  select r.sort_order, r.is_assignable
    into v_sort_order, v_is_assignable
    from public.roles r
   where r.key = v_key;

  if v_sort_order is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- Owner decision 1, in three parts: the assignability flag, the one key that is never grantable, and the
  -- ceiling. Each is its own refusal, because each means something different to the person reading it.
  if not v_is_assignable then
    return query select 'role_not_assignable'::text, v_key;
    return;
  end if;

  if v_key = 'super_admin' then
    return query select 'role_not_grantable'::text, v_key;
    return;
  end if;

  v_ceiling := app_private.staff_role_ceiling(p_user_id, p_is_aal2);
  if v_ceiling is null or v_sort_order > v_ceiling then
    return query select 'role_above_ceiling'::text, v_key;
    return;
  end if;

  -- Owner decision 4. 0003's `user_roles_expiry_after_grant` would refuse this as a constraint violation;
  -- checked here so the console receives a refusal it can explain instead of a failed statement.
  if p_expires_at is not null and p_expires_at <= now() then
    return query select 'role_expiry_invalid'::text, v_key;
    return;
  end if;

  -- `on conflict on constraint` rather than a column list: this function has an OUT parameter called
  -- `role_key`, and a bare `role_key` in a conflict target is ambiguous between that variable and the column.
  -- Naming 0003's own primary key says exactly which pairing is meant and reads as the intent.
  insert into public.user_roles (user_id, role_key, granted_by, granted_at, expires_at, reason)
  values (p_target_user_id, v_key, p_user_id, now(), p_expires_at, v_reason)
  on conflict on constraint user_roles_pkey do update
    set granted_by = excluded.granted_by,
        granted_at = excluded.granted_at,
        expires_at = excluded.expires_at,
        reason = excluded.reason,
        -- Owner decision 5: reinstatement happens here and nowhere else. There is no operation in this
        -- migration that clears these two columns without recording a fresh grant beside them.
        revoked_at = null,
        revoked_by = null;

  return query select 'granted'::text, v_key;
end;
$$;

comment on function app_private.staff_role_grant(uuid, boolean, uuid, text, text, timestamptz) is
  'Grants one role to one account, or reinstates a revoked grant by recording a fresh one. Requires users.role.manage at the assurance level the holding role demands. Refuses a self-grant, a blank reason, a role that is not assignable, super_admin in every case, any role above the caller''s own highest effective role, and an expiry that is not in the future. Writes granted_by from the caller and never names 8-B''s audit channel. Clears revoked_at only as part of recording a new grant.';

-- ---------------------------------------------------------------------------------------------------
-- 5. Revoking
-- ---------------------------------------------------------------------------------------------------
-- Outcomes: `not_found`, `role_is_self`, `role_reason_required`, `role_above_ceiling`, `role_not_revocable`
-- (`super_admin`), `role_already_revoked`, and `revoked`.
--
-- The row is locked before it is read, so two colleagues acting at once produce one revocation and one
-- `role_already_revoked` rather than two writes.
create or replace function app_private.staff_role_revoke(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_target_user_id uuid,
  p_role_key text,
  p_reason text
) returns table (
  outcome text,
  role_key text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  -- The same whitespace set as the grant writer: spaces alone are not what "blank" means.
  v_reason text := nullif(btrim(coalesce(p_reason, ''), E' \t\r\n'), '');
  v_key text := nullif(btrim(coalesce(p_role_key, ''), E' \t\r\n'), '');
  v_sort_order integer;
  v_revoked_at timestamptz;
  v_ceiling integer;
  v_found boolean := false;
begin
  if p_user_id is null or p_target_user_id is null or v_key is null
     or not app_private.staff_role_can_manage(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  if p_user_id = p_target_user_id then
    return query select 'role_is_self'::text, null::text;
    return;
  end if;

  if v_reason is null then
    return query select 'role_reason_required'::text, null::text;
    return;
  end if;

  select r.sort_order into v_sort_order from public.roles r where r.key = v_key;
  if v_sort_order is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- The approved rule recorded in this file's header: a role that cannot be granted cannot be taken away here
  -- either, so this console can neither create nor destroy a super_admin. Owner-confirmed, not inferred.
  if v_key = 'super_admin' then
    return query select 'role_not_revocable'::text, v_key;
    return;
  end if;

  v_ceiling := app_private.staff_role_ceiling(p_user_id, p_is_aal2);
  if v_ceiling is null or v_sort_order > v_ceiling then
    return query select 'role_above_ceiling'::text, v_key;
    return;
  end if;

  select true, ur.revoked_at
    into v_found, v_revoked_at
    from public.user_roles ur
   where ur.user_id = p_target_user_id
     and ur.role_key = v_key
     for update;

  if not coalesce(v_found, false) then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  if v_revoked_at is not null then
    return query select 'role_already_revoked'::text, v_key;
    return;
  end if;

  -- An update, never a delete (owner decision 5). The grant and its withdrawal stay on one row.
  update public.user_roles ur
     set revoked_at = now(),
         revoked_by = p_user_id,
         reason = v_reason
   where ur.user_id = p_target_user_id
     and ur.role_key = v_key;

  return query select 'revoked'::text, v_key;
end;
$$;

comment on function app_private.staff_role_revoke(uuid, boolean, uuid, text, text) is
  'Withdraws one role from one account by setting revoked_at and revoked_by, never by deleting the row. Requires users.role.manage. Refuses a self-revoke, a blank reason, super_admin, any role above the caller''s own effective ceiling, and a grant that is already revoked. That the ceiling governs withdrawal as well as granting, and that super_admin is never revocable here, are explicit owner decisions confirmed on delivery and part of this increment''s final contract. The withdrawal takes effect when the permission predicates are next evaluated: nothing in this platform ends a session.';

-- ---------------------------------------------------------------------------------------------------
-- 6. Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema app_private from public;

revoke execute on function app_private.staff_role_can_manage(uuid, boolean) from public, app_worker;
revoke execute on function app_private.staff_role_ceiling(uuid, boolean) from public, app_worker;
revoke execute on function app_private.staff_role_grantable(uuid, boolean) from public, app_worker;
revoke execute on function app_private.staff_role_grant(uuid, boolean, uuid, text, text, timestamptz) from public, app_worker;
revoke execute on function app_private.staff_role_revoke(uuid, boolean, uuid, text, text) from public, app_worker;

-- `app_system` only. The worker grants nobody anything: no schedule and no event in this platform changes who
-- holds a role, and the one process that runs unattended is the one that should least be able to. No table
-- privilege on `public.user_roles`, `public.roles`, `public.permissions` or `public.role_permissions` is
-- granted anywhere by this migration.
grant execute on function app_private.staff_role_can_manage(uuid, boolean) to app_system;
grant execute on function app_private.staff_role_ceiling(uuid, boolean) to app_system;
grant execute on function app_private.staff_role_grantable(uuid, boolean) to app_system;
grant execute on function app_private.staff_role_grant(uuid, boolean, uuid, text, text, timestamptz) to app_system;
grant execute on function app_private.staff_role_revoke(uuid, boolean, uuid, text, text) to app_system;

-- The contract this repository will not ship without.
select app_private.assert_security_contract();
