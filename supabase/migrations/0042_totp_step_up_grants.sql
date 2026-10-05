-- 0042 — Issuing a step-up grant from a TOTP verification (flow F5, increment F5-A; owner decision
-- F5-T-5).
--
-- The specification's step-up flow names two sources of proof:
--
--   > Step-up | Our OTP or a Supabase TOTP challenge, recorded in `step_up_grants` with a short
--   > validity; required for password change, payout-detail change, account deletion,
--   > revoke-all-sessions
--
-- 0036 implemented the first source. This migration adds the writer for the second, and nothing else:
-- there is no TOTP enrollment, no TOTP verification, no provider call and no route anywhere in this
-- file or in this increment. Those belong to F5-B, which stays gated on the O-1 and AUTH-10 evidence
-- that this environment cannot produce.
--
-- **Why this is a separate function rather than a widened `issue_step_up_grant`.**
-- 0036 takes a challenge id and a code hash, verifies the challenge itself, and derives `granted_via`
-- from the challenge's own channel — the point being that "the record of how someone proved themselves
-- must not be something they can assert". A TOTP challenge leaves no row in `app_private.otp_challenges`
-- to verify against, so that shape cannot express it: the partial unique index 0036 added says as much
-- in its own comment, "a TOTP grant carries no challenge id". Widening 0036 would mean making its
-- challenge id optional and its derivation conditional, which would weaken the guarantee for the OTP
-- path as well. 0036 and 0037 are therefore left exactly as they are.
--
-- **What that costs, stated plainly.** For this one path the proof boundary moves out of PostgreSQL:
-- the database records `granted_via = 'totp'` because `app_system` said so, with nothing here able to
-- check it. Owner decision F5-T-5 adopts that knowingly. What the database still guarantees is narrow
-- but real, and it is what this function is shaped to give:
--
--   * this function can issue no `granted_via` other than 'totp' — the value is a literal, not an
--     argument, so no caller can claim an OTP grant through it or a TOTP grant through 0036;
--   * it can issue no validity other than C-16's ten minutes, which is likewise fixed here;
--   * it names one operation and one user, and the grant it writes is spent by the unmodified
--     `app_private.consume_step_up_grant` (C-19) under exactly the same single-use, single-operation,
--     single-owner rules as an OTP grant;
--   * it is reachable by `app_system` alone, like every other writer since 0034.
--
-- No table privilege is granted, the 0004 self-read policy is untouched, `has_step_up_grant` is
-- untouched, and no existing function is modified.

-- ---------------------------------------------------------------------------------------------------
-- The TOTP writer
-- ---------------------------------------------------------------------------------------------------
-- Neither refusal raises. A missing account and a blank operation are ordinary answers a caller must
-- handle, not faults: raising would roll back the caller's transaction and turn a refusal into an
-- incident. This matches 0039's `unknown_user` and 0041's `not_found`, and differs from 0036 only
-- because 0036's equivalents are argument-shape errors that a correct caller cannot produce.
create or replace function app_private.issue_totp_step_up_grant(
  p_user_id uuid,
  p_operation text
) returns table (
  outcome text,
  grant_id uuid,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  -- Owner decision C-16, fixed here for the same reason 0036 fixes it: the duration of an
  -- authorisation is a security fact, and a caller must not be able to influence it.
  c_validity constant interval := interval '10 minutes';
  v_grant_id uuid;
  v_expires timestamptz;
begin
  if p_operation is null or btrim(p_operation) = '' then
    return query select 'invalid_operation'::text, null::uuid, null::timestamptz;
    return;
  end if;

  -- `step_up_grants.user_id` is not null and references `auth.users`; an unknown account is reported
  -- rather than left to the foreign key, so the caller gets an outcome instead of an error.
  if p_user_id is null or not exists (select 1 from auth.users u where u.id = p_user_id) then
    return query select 'no_user'::text, null::uuid, null::timestamptz;
    return;
  end if;

  v_expires := now() + c_validity;

  -- 'totp' is a literal and `challenge_id` is null: the first because no caller may name its own proof,
  -- the second because there is no challenge row to name. The 0036 partial unique index is defined on
  -- `challenge_id is not null`, so several TOTP grants coexist without colliding.
  insert into public.step_up_grants (user_id, operation, granted_via, challenge_id, expires_at)
  values (p_user_id, p_operation, 'totp', null, v_expires)
  returning id into v_grant_id;

  return query select 'granted'::text, v_grant_id, v_expires;
end;
$$;

comment on function app_private.issue_totp_step_up_grant(uuid, text) is
  'Records a 10-minute step-up grant for one operation from a TOTP verification the application layer has already established (C-16, F5-T-5). granted_via is always totp and challenge_id is always null; neither is a parameter. Issues nothing for an unknown user or a blank operation.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.issue_totp_step_up_grant(uuid, text) from public;

-- The API role alone, exactly as for 0036's issuer and 0037's consumer. `authenticated` keeps only the
-- read-only view of its own grants from the 0004 policy: a browser that could call this could mint its
-- own step-up authorisation, which is the whole thing a step-up grant exists to prevent.
grant execute on function app_private.issue_totp_step_up_grant(uuid, text) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
