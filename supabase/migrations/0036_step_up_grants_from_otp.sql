-- 0036 — Step-up grants issued by a verified OTP (flow F5, the "our OTP" half; owner decision C-16).
--
-- The specification's step-up flow:
--
--   > Step-up | Our OTP or a Supabase TOTP challenge, recorded in `step_up_grants` with a short
--   > validity; required for password change, payout-detail change, account deletion,
--   > revoke-all-sessions
--
-- Owner decisions closing the two gaps the audit found:
--
--   C-16: the grant is valid for exactly 10 minutes. 0004 left `expires_at` not-null with no default,
--   so the duration had to come from the owner rather than from the schema.
--
--   A WhatsApp OTP is recorded as `otp_whatsapp`. It is explicitly **not** mapped onto `otp_sms`:
--   WhatsApp is not SMS, and a security audit table that says otherwise is a lie in the place it
--   matters most.
--
-- 0004 created `step_up_grants` with a read helper and no writer. Verified against a live database
-- before this file was written:
--
--   app_api / app_system / app_worker / anon -> NONE on public.step_up_grants
--   authenticated       -> SELECT only, through the self-read RLS policy
--   functions touching it: public.has_step_up_grant (read-only)
--
-- So the writer is a named SECURITY DEFINER function granted to `app_system` alone, exactly as 0034 and
-- 0035 did. No table privilege is granted, no policy is added, and `has_step_up_grant` is untouched.
--
-- Only the "our OTP" half is implemented. The TOTP half needs a live Supabase project and is out of
-- scope here.

-- ---------------------------------------------------------------------------------------------------
-- The WhatsApp grant source
-- ---------------------------------------------------------------------------------------------------
-- 0004 allowed 'totp', 'otp_email' and 'otp_sms'. `otp_challenges.channel` has allowed 'whatsapp' since
-- 0004 as well, so a WhatsApp OTP had no truthful way to be recorded here. Widening the domain is the
-- smallest correct fix; nothing existing is removed, so every row already stored stays valid.
alter table public.step_up_grants drop constraint step_up_grants_via_allowed;
alter table public.step_up_grants add constraint step_up_grants_via_allowed
  check (granted_via in ('totp', 'otp_email', 'otp_sms', 'otp_whatsapp'));

-- ---------------------------------------------------------------------------------------------------
-- One grant per challenge, structurally
-- ---------------------------------------------------------------------------------------------------
-- `verify_otp_challenge` already consumes a challenge exactly once under a row lock, so a second
-- concurrent verification returns 'consumed' and issues nothing. This index is the second line of
-- defence: even a future code path that skipped that guarantee could not record two grants against one
-- challenge. Partial, because a TOTP grant carries no challenge id.
create unique index if not exists step_up_grants_one_per_challenge
  on public.step_up_grants (challenge_id) where challenge_id is not null;

-- ---------------------------------------------------------------------------------------------------
-- Verifying an OTP and issuing the grant, in one call
-- ---------------------------------------------------------------------------------------------------
-- Verification and issuance are deliberately not separable. If a caller could verify first and issue
-- afterwards, two concurrent callers could both observe "verified" before either recorded a grant. Here
-- the verification happens inside this function's transaction, so the single consumption that
-- `verify_otp_challenge` guarantees is the same event that authorises the grant.
--
-- `granted_via` is derived from the challenge's own channel, never supplied by the caller: the record of
-- how someone proved themselves must not be something they can assert.
create or replace function app_private.issue_step_up_grant(
  p_challenge_id uuid,
  p_code_hash bytea,
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
  -- Owner decision C-16.
  c_validity constant interval := interval '10 minutes';
  v_verdict text;
  v_challenge app_private.otp_challenges%rowtype;
  v_via text;
  v_grant_id uuid;
  v_expires timestamptz;
begin
  if p_code_hash is null then
    raise exception 'code hash is required' using errcode = '22023';
  end if;
  if p_operation is null or btrim(p_operation) = '' then
    raise exception 'operation is required' using errcode = '22023';
  end if;

  -- The only door. Anything other than 'verified' — invalid, expired, consumed, too_many_attempts or
  -- not_found — returns here and issues nothing.
  v_verdict := app_private.verify_otp_challenge(p_challenge_id, p_code_hash);
  if v_verdict <> 'verified' then
    return query select v_verdict, null::uuid, null::timestamptz;
    return;
  end if;

  select * into v_challenge from app_private.otp_challenges c where c.id = p_challenge_id;

  -- A grant names a user; `step_up_grants.user_id` is not null. A challenge sent to an address that
  -- matched no account cannot authorise anything, and the consumed challenge is not given back.
  if v_challenge.user_id is null then
    return query select 'no_user'::text, null::uuid, null::timestamptz;
    return;
  end if;

  v_via := case v_challenge.channel
             when 'whatsapp' then 'otp_whatsapp'
             when 'email' then 'otp_email'
             when 'sms' then 'otp_sms'
           end;
  if v_via is null then
    raise exception 'unknown OTP channel %', v_challenge.channel using errcode = '22023';
  end if;

  v_expires := now() + c_validity;

  insert into public.step_up_grants (user_id, operation, granted_via, challenge_id, expires_at)
  values (v_challenge.user_id, p_operation, v_via, p_challenge_id, v_expires)
  returning id into v_grant_id;

  return query select 'granted'::text, v_grant_id, v_expires;
end;
$$;

comment on function app_private.issue_step_up_grant(uuid, bytea, text) is
  'Verifies an OTP and, only on success, records a 10-minute step-up grant for one operation (C-16). granted_via is derived from the challenge channel, never from the caller.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.issue_step_up_grant(uuid, bytea, text) from public;

-- The API role alone. `authenticated` keeps its read-only view of its own grants through the 0004
-- policy and gains nothing here; the worker has no part in step-up.
grant execute on function app_private.issue_step_up_grant(uuid, bytea, text) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
