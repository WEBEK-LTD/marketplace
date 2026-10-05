-- 0068 — The staff console access reader (Phase 7-F).
--
-- **One function. Nothing else.** No table, column, constraint, index, trigger or policy is created or
-- changed, no role or permission row is touched, no role-permission assignment is altered, and nothing
-- in 0003, 0004, 0033, 0036 or 0042 is modified. The AAL2 machinery is exactly where 7-B left it.
--
-- **Why a new reader is needed at all.** 0003 already answers every authorization question this shell
-- asks — `public.has_permission`, `public.has_role`, `public.is_aal2` — but all three resolve their
-- caller through `app_private.jwt_claims()`, which reads the verified JWT of an `authenticated`
-- session. Under the approved architecture (M-1, owner Decision 1 Option B) the admin application
-- reaches the database only through the API, which connects as `app_system`: not `authenticated`, and
-- carrying no claims at all. Those three helpers therefore answer *false for every account* when called
-- from this path — correctly, since they were written for a caller with a session. This is their
-- `app_system` counterpart, exactly as 0066 was for `unread_notification_count` and 0067 for the buyer
-- surfaces. All three originals keep their grants and are untouched.
--
-- **The MFA rule is not restated here; it is the same expression.** `has_permission` counts a role only
-- when `not r.requires_mfa or public.is_aal2()`. This function uses `not r.requires_mfa or p_is_aal2`,
-- the identical predicate with the assurance level passed in rather than read from a claim the caller's
-- connection does not have. There is no second copy of the rule and no place for the two to disagree:
-- what is passed in is the *only* difference, and where it comes from is the API's problem, not this
-- function's.
--
-- **The assurance level is a parameter, and that is deliberate.** `app_system` has no way to observe it,
-- so it has to arrive from the caller — and the caller is the API, which reads it from the `aal` claim of
-- an access token the provider has just validated. It is never a value a browser asserts: a browser
-- sends a token, the provider says whether that token is genuine, and only then are its own claims read.
-- A missing, unrecognised or malformed claim is `false` here and at every layer above.
--
-- **What it returns, and why each part exists.**
--
--   * `has_console_role` — whether the account holds an effective `is_admin_console` role **ignoring the
--     assurance level**. This is what tells the shell apart the two refusals it must handle differently:
--     staff who have not completed a second factor are sent to the existing challenge, while everybody
--     else gets the neutral refusal. It discloses nothing: an account already knows whether it is staff.
--   * `roles` and `permissions` — the effective sets **with** the MFA rule applied. For staff at aal1
--     both are empty, which is precisely "nothing privileged at aal1" from the authorization matrix.
--   * `requires_step_up` — `has_console_role and not p_is_aal2`, computed here so the API and the shell
--     cannot derive it differently.
--
-- The account is a parameter and appears in the predicate itself, so this call cannot ask about anybody
-- else's roles: there is no branch that decides whether to scope the query, because the scope is the
-- query. Nothing here grants, promotes, assigns or revokes anything — it is `language sql stable`, which
-- makes writing impossible rather than merely absent.

create or replace function app_private.staff_console_access(
  p_user_id uuid,
  p_is_aal2 boolean
) returns table (
  has_console_role boolean,
  requires_step_up boolean,
  roles text[],
  permissions text[]
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with effective as (
    -- Every role assignment that is currently in force, before the assurance rule is applied.
    select r.key, r.requires_mfa, r.is_admin_console
      from public.user_roles ur
      join public.roles r on r.key = ur.role_key
     where ur.user_id = p_user_id
       and ur.revoked_at is null
       and (ur.expires_at is null or ur.expires_at > now())
  ),
  console as (
    select exists (select 1 from effective where is_admin_console) as held
  ),
  allowed as (
    -- 0003's own rule, with the assurance level supplied instead of read from a claim.
    select key from effective where not requires_mfa or coalesce(p_is_aal2, false)
  )
  select
    console.held,
    console.held and not coalesce(p_is_aal2, false),
    coalesce((select array_agg(a.key order by a.key) from allowed a), array[]::text[]),
    coalesce(
      (select array_agg(distinct rp.permission_key order by rp.permission_key)
         from public.role_permissions rp
         join allowed a on a.key = rp.role_key),
      array[]::text[]
    )
    from console;
$$;

comment on function app_private.staff_console_access(uuid, boolean) is
  'The effective roles and permissions of one account for the admin console, under 0003''s own requires_mfa rule with the assurance level supplied by the API rather than read from a JWT claim this connection does not have. Returns empty sets for staff who have not reached aal2, which is "nothing privileged at aal1" from the authorization matrix. has_console_role ignores the assurance level so the console can tell staff who must step up apart from everybody else; nothing here writes, grants or promotes anything.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke all on function app_private.staff_console_access(uuid, boolean) from public;

-- The API role alone. `authenticated` gains nothing: it already has 0003's three helpers, which resolve
-- the caller from its own verified session, and a function that takes an account **and an assurance
-- level** as parameters must never be callable by something that could choose either.
grant execute on function app_private.staff_console_access(uuid, boolean) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
