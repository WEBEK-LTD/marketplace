-- 0034 — Login-attempt recording and durable account lockout (Phase 3 Step 1; AUTH-3 / N1, O-11).
--
-- This is the first Phase 3 migration. It exists because the Phase 2 schema physically cannot satisfy
-- the approved lockout requirement, which was verified against a live database before this file was
-- written rather than assumed:
--
--   app_system / app_private.login_attempts   -> NONE
--   app_system / app_private.account_lockouts -> NONE
--   (app_api, app_worker, authenticated, anon: NONE on both tables)
--   functions touching either table: app_private.is_account_locked(uuid) — read-only
--
-- 0004 created `login_attempts` and `account_lockouts` but no writer, and the 0031 role-boundary
-- contract forbids giving `app_system` table privileges. So the only route that preserves every
-- existing security contract is the established Phase 2 pattern: a named SECURITY DEFINER function
-- with a pinned search_path, granted to `app_system` alone.
--
-- What the specification requires, verbatim:
--
--   > BFF → `POST /v1/auth/login` → durable lockout check (PostgreSQL) and throttles → Supabase
--   > password sign-in → …
--
--   > Fallback lockout model (N1): NestJS enforces durable lockout before any Supabase call …
--   > The password-verification hook is not required
--
--   > … 5 failed logins in 15 min → 15-min lock
--
-- The threshold, window and lock duration are therefore **specified values, not chosen ones**. They are
-- pinned as constants inside the function rather than exposed as parameters, so that no caller — not
-- even a future bug in the API — can weaken the policy by passing different numbers. Changing the
-- policy requires a migration and an owner decision, which is the intent of an approved decision row.
--
-- Deliberately NOT in this migration, because the specification does not define them:
--
--   * **Login throttles.** The login flow says "and throttles", but every numeric rate limit in the
--     specification ("5/h and 10/day per destination; 20/h per IP") belongs to the OTP row. No limit is
--     defined for password login. `app_private.rate_limit_hit()` already exists and is already granted;
--     it is left untouched here and awaits an owner decision on its values.
--   * **Lock release by an operator.** The specification states a 15-minute lock and nothing about
--     manual release. `account_lockouts.released_at` / `released_by` exist from 0004 and stay unused by
--     this migration; expiry is by `locked_until`, which `is_account_locked()` already honours.
--   * **Lockout escalation.** The specification defines one lock duration. There is no second tier.
--
-- Scope of the lock is per account, which is not a choice made here: `account_lockouts.user_id` is the
-- primary key, so 0004 already fixed the lock to an account. A failed attempt against an identifier
-- that matches no user is recorded (it is evidence) but cannot lock anything, because `user_id` is a
-- foreign key to `auth.users`. That is a property of the Phase 2 schema, not a new decision.

-- ---------------------------------------------------------------------------------------------------
-- Recording an attempt and applying the approved lockout rule
-- ---------------------------------------------------------------------------------------------------

-- One round trip does both halves of the rule, inside one statement-level transaction, so a failed
-- attempt can never be recorded without the lockout evaluation that the specification attaches to it.
create or replace function app_private.record_login_attempt(
  p_user_id uuid,
  p_identifier_hash bytea,
  p_succeeded boolean,
  p_failure_reason text default null,
  p_request_ip inet default null,
  p_user_agent_hash bytea default null
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  -- Approved decision row: "5 failed logins in 15 min → 15-min lock".
  c_threshold constant integer := 5;
  c_window constant interval := interval '15 minutes';
  c_lock_duration constant interval := interval '15 minutes';
  v_recent_failures integer;
begin
  if p_identifier_hash is null then
    raise exception 'identifier hash is required' using errcode = '22023';
  end if;
  if p_succeeded is null then
    raise exception 'attempt outcome is required' using errcode = '22023';
  end if;

  -- 0004 constrains a failed attempt to carry a reason. Supply a neutral one rather than rejecting the
  -- write: losing the evidence of a failure would be worse than a generic reason.
  insert into app_private.login_attempts
    (user_id, identifier_hash, succeeded, failure_reason, request_ip, user_agent_hash)
  values (
    p_user_id,
    p_identifier_hash,
    p_succeeded,
    case when p_succeeded then p_failure_reason else coalesce(p_failure_reason, 'unspecified') end,
    p_request_ip,
    p_user_agent_hash
  );

  -- Nothing to lock: either the attempt succeeded, or the identifier matched no account.
  if p_succeeded or p_user_id is null then
    return app_private.is_account_locked(p_user_id);
  end if;

  select count(*)
    into v_recent_failures
    from app_private.login_attempts a
   where a.user_id = p_user_id
     and not a.succeeded
     and a.created_at > now() - c_window;

  if v_recent_failures < c_threshold then
    return app_private.is_account_locked(p_user_id);
  end if;

  -- At or past the threshold. `user_id` is the primary key, so a repeat failure refreshes the existing
  -- row rather than stacking locks. A previously released row is re-locked by clearing the release.
  insert into app_private.account_lockouts
    (user_id, locked_at, locked_until, reason, failed_attempts)
  values (p_user_id, now(), now() + c_lock_duration, 'failed_login_threshold', v_recent_failures)
  on conflict (user_id) do update
    set locked_at = now(),
        locked_until = now() + c_lock_duration,
        reason = 'failed_login_threshold',
        failed_attempts = excluded.failed_attempts,
        released_at = null,
        released_by = null;

  return true;
end;
$$;

comment on function app_private.record_login_attempt(uuid, bytea, boolean, text, inet, bytea) is
  'Records one login attempt and applies the approved lockout rule (5 failed logins in 15 min -> 15-min lock). Returns whether the account is locked after the attempt. The policy values are fixed here, not caller-supplied.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
-- 0004 already revoked EXECUTE on all app_private functions from PUBLIC, but a function created after
-- that statement carries its own default grant, so it is revoked explicitly here.
revoke execute on function app_private.record_login_attempt(uuid, bytea, boolean, text, inet, bytea) from public;

-- Only the API role. The worker has no reason to record a login attempt, and `app_api` acts as
-- `authenticated`, which must never reach app_private.
grant execute on function app_private.record_login_attempt(uuid, bytea, boolean, text, inet, bytea)
  to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
-- Deploy-time assertion, exactly as 0031 and 0032 end. A privilege mistake in this migration fails the
-- deployment rather than shipping.
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
