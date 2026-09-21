-- 0037 — Consuming a step-up grant (owner decision C-19; completes the "our OTP" half of F5).
--
-- 0036 issues a grant; nothing spent one. `consumed_at` and the read helper that honours it have existed
-- since 0004, so this migration adds only the missing verb.
--
-- Approved C-19 semantics:
--
--   1. A grant is single-use.
--   2. It is consumed only when the protected operation actually succeeds.
--   3. Merely checking it does not consume it.
--   4. A failed operation — validation, business rule, provider or internal error — leaves it unconsumed.
--   5. On success it is marked consumed atomically.
--   6. It cannot be used again afterwards.
--   7. It authorises only its own `operation`.
--   8. The 10-minute expiry is unchanged.
--   9. An expired grant authorises nothing.
--  10. Concurrent attempts allow at most one successful operation.
--
-- **Why this is one statement.** Every condition lives in the UPDATE's WHERE clause, so there is no
-- window between deciding and consuming — the check *is* the consumption. A read-then-write version of
-- this function would be wrong however carefully it were written: two callers could both read a valid
-- grant before either wrote, and both would proceed.
--
-- **How that survives concurrency.** Under READ COMMITTED a second UPDATE of the same row blocks on the
-- row lock, then re-evaluates its WHERE against the committed new version. `consumed_at` is no longer
-- null, so it matches no rows and reports failure. PostgreSQL does the serialisation; this function only
-- has to avoid stepping outside it.
--
-- **How "only on success" is reconciled with that.** The lock is held until the caller's transaction
-- ends, so the caller consumes and then performs the protected operation *inside the same transaction*.
-- If the operation fails the transaction rolls back and the consumption is undone, satisfying rule 4;
-- if it succeeds the commit makes both permanent, satisfying rule 5. A concurrent attempt waits on the
-- lock and succeeds only if the first attempt rolled back — which is rule 10, stated in terms of
-- successful operations rather than attempts.
--
-- The protected operations themselves (password change, payout-detail change, account deletion,
-- revoke-all-sessions) are not implemented here. This is the reusable primitive they will call.

create or replace function app_private.consume_step_up_grant(
  p_grant_id uuid,
  p_user_id uuid,
  p_operation text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  consumed integer;
begin
  if p_grant_id is null or p_user_id is null then
    raise exception 'grant id and user id are required' using errcode = '22023';
  end if;
  if p_operation is null or btrim(p_operation) = '' then
    raise exception 'operation is required' using errcode = '22023';
  end if;

  -- Grant exists, belongs to this user, covers this operation, has not expired and has not been used.
  -- All five in the predicate, so the decision and the write cannot be separated.
  update public.step_up_grants
     set consumed_at = now()
   where id = p_grant_id
     and user_id = p_user_id
     and operation = p_operation
     and consumed_at is null
     and expires_at > now();

  get diagnostics consumed = row_count;

  -- A plain boolean. Distinguishing "wrong user" from "expired" from "already used" would tell a caller
  -- things about grants that are not theirs; the authorisation answer is the only thing they need.
  return consumed = 1;
end;
$$;

comment on function app_private.consume_step_up_grant(uuid, uuid, text) is
  'Atomically consumes one unexpired, unused step-up grant for its own user and operation (C-19). Returns whether the operation is authorised. Call inside the transaction that performs the operation, so a failure rolls the consumption back.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.consume_step_up_grant(uuid, uuid, text) from public;

-- The API role alone. `authenticated` keeps the read-only view of its own grants from the 0004 policy
-- and gains nothing: a browser must never be able to mark its own authorisation as spent, or to spend
-- one without the operation behind it.
grant execute on function app_private.consume_step_up_grant(uuid, uuid, text) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
