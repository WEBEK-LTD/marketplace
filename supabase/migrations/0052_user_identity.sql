-- 0052 — The signed-in caller's own identity (Phase 5-A, session continuity).
--
-- One reader, for one question: given a user the API has already authenticated, what is the minimum
-- identity a signed-in surface needs to render? The approved answer is the account id and the display
-- name, and nothing else — no email, no phone, no verification state, no role, no seller record.
--
-- **The caller is never named by the request.** The API resolves the account from the caller's own
-- access token through the provider before this function is reached, so `p_user_id` is always a value
-- the server established, never one a browser supplied. That is why the function takes an id rather
-- than reading a JWT claim: under the approved architecture (M-1) every authenticated operation runs
-- through `app_system`, which is not `authenticated` and carries no claims, so a claim-reading helper
-- would find nothing here.
--
-- **A deleted profile has no identity.** `profiles.deleted_at` is the schema's own record that the
-- person is gone (0005 keeps `status = 'deleted'` and `deleted_at` in step by constraint), and this
-- reader returns no row for one. The API turns that into the same "no usable session" refusal a missing
-- token gets, so a deleted account cannot keep using a live token until it expires. A *suspended*
-- profile is deliberately not filtered: suspension is a moderation state whose consequences are decided
-- by the surfaces that enforce it, and inventing a sign-out rule for it here would be a policy this
-- migration does not own.
--
-- Nothing else is added. No messaging table, no messaging function, no grant to `authenticated`, and no
-- change to any applied migration.

-- ---------------------------------------------------------------------------------------------------
-- The identity reader
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.user_identity(p_user_id uuid)
returns table (
  id uuid,
  display_name text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p.id, p.display_name
    from public.profiles p
   where p.id = p_user_id
     and p.deleted_at is null;
$$;

comment on function app_private.user_identity(uuid) is
  'The minimum identity of one account: id and display name. Returns no row for a deleted profile, which the API treats as no usable session. Never returns contact details, verification state or any other private account field.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.user_identity(uuid) from public;
grant execute on function app_private.user_identity(uuid) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
