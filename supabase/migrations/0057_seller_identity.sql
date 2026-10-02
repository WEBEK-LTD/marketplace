-- 0057 — The authenticated seller's own identity (Phase 6-A).
--
-- One reader, and nothing else. No table, no column, no trigger, no policy, no grant to `authenticated`,
-- and no write path of any kind: a seller profile cannot be created, edited, activated, suspended or
-- closed by anything in this file. 0009 built the seller schema in Phase 2 and stays exactly as it was.
--
-- **Why a second seller reader exists.** 0050 already reads a seller *by public slug*, and that reader is
-- frozen: it answers the question a guest asks and returns the five fields 4-E approved. This one answers
-- a different question — "what is my own storefront's state?" — for a caller the API has already
-- identified. The two differ in what they are allowed to say:
--
--   * 0050 hides the state. A pending seller, a closed seller and a slug that names nobody are one
--     indistinguishable not-found, because a guest learning that an unapproved application exists is
--     exactly the leak that reader prevents.
--   * This one *is* the state. A seller must be able to see that their own profile is pending review,
--     suspended or closed — it is their own account, and hiding it from them would make the surface
--     unusable rather than private.
--
-- So they are separate functions rather than one with a flag: a single reader with two disclosure modes
-- is one mistaken argument away from answering the guest's question with the owner's answer.
--
-- **Where the caller comes from.** `p_user_id` is always a value the API established from the caller's
-- own access token, through the provider and then the database, before any of this runs (the Phase 5-A
-- path). It is never a value a browser supplied, and no seller identity is ever inferred from a slug the
-- caller typed. The `where` clause below still names `p_user_id`, so the function reads one row — that
-- caller's — and has no parameter with which anybody could ask about a different seller.
--
-- **What it returns, and what it therefore cannot leak.** Exactly the six approved fields: `slug`,
-- `display_name`, `status`, `verification_status`, `city`, `country_code`. Not the seller's own
-- `user_id` — a browser has no use for it and the surfaces that need to act do so through the session —
-- and not `legal_name`, the contact e-mail or phone, `suspension_reason`, `logo_object_path`,
-- `banner_object_path`, any timestamp, or anything about verification documents or moderation. The return
-- type is the whole of the contract: a field that is not in it cannot be selected by accident later.

-- ---------------------------------------------------------------------------------------------------
-- The caller's own seller identity
-- ---------------------------------------------------------------------------------------------------
-- No row means "not a seller", which is the honest answer for an account that has never applied. It is
-- not an error and it is not an empty seller: a caller with no storefront has no storefront state, and
-- the API turns the absence into a not-found rather than into a fabricated profile.
--
-- Every status is reported, `closed` included. Whether a given status may *do* something is a question
-- for the writers that follow, each of which decides it for itself; a reader that hid the state would
-- leave a suspended seller looking at a working dashboard.
create or replace function app_private.seller_identity(p_user_id uuid)
returns table (
  slug text,
  display_name text,
  status text,
  verification_status text,
  city text,
  country_code char(2)
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select s.slug,
         s.display_name,
         s.status,
         s.verification_status,
         s.city,
         s.country_code
    from public.seller_profiles s
   where s.user_id = p_user_id;
$$;
comment on function app_private.seller_identity(uuid) is
  'The caller''s own seller identity: slug, display name, status, verification status, city and country, and nothing else. Scoped to the one row belonging to the id it is given, which the API establishes from the caller''s own session. No row means the account is not a seller. Unlike 0050''s public reader it does report pending, suspended and closed, because this is the owner asking about their own storefront rather than a guest asking about somebody else''s.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
-- S8 unchanged: one named function, PUBLIC revoked, `app_system` only. `authenticated` gains nothing,
-- `anon` gains nothing, and no table privilege is granted anywhere. 0009's own owner-write policies for
-- `authenticated` stay exactly as they are — defence in depth for a path the application does not use.
revoke execute on function app_private.seller_identity(uuid) from public;
grant execute on function app_private.seller_identity(uuid) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
