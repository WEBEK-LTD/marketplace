-- 0039 — The password-reset token lifecycle: issue and consume (C-18).
--
-- `app_private.password_reset_tokens` was created by 0004 with row level security on, no policies and no
-- grants — and, like `login_attempts` before 0034 and `otp_challenges` before 0035, with nothing able to
-- write it. Verified against the live sandbox schema before this file was written:
--
--   app_api / app_system / app_worker / authenticated / anon -> NONE on app_private.password_reset_tokens
--   functions touching it: none
--
-- The 0031 role-boundary contract forbids granting `app_system` table privileges, so the only route that
-- preserves every existing contract is the established pattern: named SECURITY DEFINER functions with a
-- pinned search_path, EXECUTE granted to `app_system` alone.
--
-- The approved design, quoted from the specification's Forgot-password flow, is:
--
--   > Neutral response always -> OTP only to a verified contact -> single-use hashed reset token
--   > (15 min, httpOnly/Secure/SameSite=Strict) -> ... -> token consumed, all sessions revoked
--
-- Three consequences are built in here and nowhere else:
--
--   **Hashed.** The clear token never reaches this database. The API generates 256 bits of randomness,
--   hands it to the person through the reset link, and sends only its digest here. `token_hash` is the
--   lookup key precisely because the clear value is not stored: a reader of this table cannot use, or
--   work back to, any live token. The functions below refuse a digest shorter than 256 bits, so a weak
--   or truncated digest cannot be written by mistake.
--
--   **15 minutes.** The lifetime is a constant in `issue_password_reset_token`, not a parameter. A caller
--   cannot ask for a longer-lived token, because the approved value is not the caller's to choose.
--
--   **Single use, atomically.** `consume_password_reset_token` locks the row before it decides, so two
--   simultaneous consumptions of the same token cannot both succeed: the second waits, then sees
--   `consumed_at` already set. That is the same mechanism 0035 uses for an OTP challenge, and it is the
--   reason the decision and the write cannot be separated.
--
-- Deliberately NOT here, because no approved decision defines them:
--
--   * **Superseding earlier tokens on re-issue.** The table records consumption, not supersession, and
--     writing `consumed_at` on a token nobody consumed would make the column lie. Every token is bound to
--     one account, single-use and valid for 15 minutes, so a second outstanding token grants nothing the
--     first did not.
--   * **Reset-specific rate limits.** The counters exist (`app_private.rate_limit_hit`) but no approved
--     numbers do; inventing them here would fix a policy that is the owner's to set.
--   * **Security events.** The C-20 writer accepts the five `auth.login.*` types only, and adding reset
--     event types would extend an approved decision from a migration.
--   * **Delivery, session revocation and the password change itself.** Those are the rest of F3.

-- ---------------------------------------------------------------------------------------------------
-- Issuing
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.issue_password_reset_token(
  p_user_id uuid,
  p_token_hash bytea,
  p_request_ip inet default null
) returns table (
  outcome text,
  token_id uuid,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  -- The approved lifetime. A constant, never a parameter.
  c_ttl constant interval := interval '15 minutes';
  v_expires timestamptz;
  v_id uuid;
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;
  -- 256 bits is the width of the digest the API produces. Anything shorter would be a weaker token
  -- store than the one that was approved, so it is refused rather than accepted quietly.
  if p_token_hash is null or octet_length(p_token_hash) < 32 then
    raise exception 'token digest is required and must be at least 32 bytes' using errcode = '22023';
  end if;

  -- An unknown account is an outcome, not an exception. The caller must be able to treat "no such user"
  -- exactly like a successful issue, because the reset request must look identical either way; letting
  -- the foreign key raise instead would hand the caller a distinguishable failure.
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    return query select 'unknown_user'::text, null::uuid, null::timestamptz;
    return;
  end if;

  v_expires := now() + c_ttl;

  insert into app_private.password_reset_tokens (user_id, token_hash, expires_at, request_ip)
  values (p_user_id, p_token_hash, v_expires, p_request_ip)
  returning id into v_id;

  return query select 'issued'::text, v_id, v_expires;
end;
$$;

comment on function app_private.issue_password_reset_token(uuid, bytea, inet) is
  'Issues one single-use reset token for an account, valid for the approved 15 minutes (C-18). Receives only the digest; the clear token never reaches the database. An unknown account returns unknown_user rather than raising, so a caller can answer identically either way.';

-- ---------------------------------------------------------------------------------------------------
-- Consuming
-- ---------------------------------------------------------------------------------------------------
-- The outcomes are distinct because the only caller is `app_system`, which needs to tell an expired
-- token from a spent one to record why a reset failed. They are internal: the F2 error mapping already
-- establishes that what the server distinguishes, the browser does not.
create or replace function app_private.consume_password_reset_token(
  p_token_hash bytea,
  p_expected_user_id uuid default null
) returns table (
  outcome text,
  user_id uuid,
  token_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v app_private.password_reset_tokens%rowtype;
  v_updated integer;
begin
  if p_token_hash is null or octet_length(p_token_hash) < 32 then
    raise exception 'token digest is required and must be at least 32 bytes' using errcode = '22023';
  end if;

  -- The lock is what makes "consumed exactly once" true under concurrency: a second simultaneous
  -- consumption of the same token waits here and then sees consumed_at already set.
  select * into v
    from app_private.password_reset_tokens t
   where t.token_hash = p_token_hash
   for update;

  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid;
    return;
  end if;
  if v.consumed_at is not null then
    return query select 'already_consumed'::text, null::uuid, null::uuid;
    return;
  end if;
  if v.expires_at <= now() then
    return query select 'expired'::text, null::uuid, null::uuid;
    return;
  end if;
  -- Binding. When the caller says which account it believes this token belongs to, a mismatch refuses
  -- the token and leaves it unconsumed — and, like every refusal here, names nobody.
  if p_expected_user_id is not null and v.user_id <> p_expected_user_id then
    return query select 'wrong_user'::text, null::uuid, null::uuid;
    return;
  end if;

  update app_private.password_reset_tokens t
     set consumed_at = now()
   where t.id = v.id
     and t.consumed_at is null
     and t.expires_at > now();
  get diagnostics v_updated = row_count;

  -- Belt and braces: the row is locked, so this cannot happen, and if it ever did the answer must be a
  -- refusal rather than an authorisation.
  if v_updated <> 1 then
    return query select 'already_consumed'::text, null::uuid, null::uuid;
    return;
  end if;

  return query select 'consumed'::text, v.user_id, v.id;
end;
$$;

comment on function app_private.consume_password_reset_token(bytea, uuid) is
  'Atomically consumes one unexpired, unused reset token, optionally checking it belongs to the expected account (C-18). Returns the owning account only on success; every refusal names nobody.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.issue_password_reset_token(uuid, bytea, inet) from public;
revoke execute on function app_private.consume_password_reset_token(bytea, uuid) from public;

-- The API role alone. `app_worker` does not issue or consume reset tokens, and `authenticated` must
-- never reach app_private: a browser that could call either of these could mint itself a reset.
grant execute on function
  app_private.issue_password_reset_token(uuid, bytea, inet),
  app_private.consume_password_reset_token(bytea, uuid)
  to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
