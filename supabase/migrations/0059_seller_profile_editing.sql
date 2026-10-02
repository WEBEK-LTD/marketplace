-- 0059 — Editing one's own storefront (Phase 6-D).
--
-- One function, and like 0058 it exists because of what a caller must *not* be able to say.
--
-- **The immutable columns are not in the SET list.** `user_id`, `slug`, `status`, `verification_status`,
-- `suspended_at`, `suspension_reason`, `closed_at`, `verified_at` and `created_at` appear nowhere in the
-- UPDATE below, and no parameter exists that could reach them. That is the whole security argument: not a
-- check that could be forgotten, but an absence. A seller cannot rename their public address, cannot
-- un-suspend themselves, cannot mark themselves verified and cannot re-date their own account, because
-- there is no expression here that assigns to any of those columns.
--
-- `updated_at` is the one exception in wording only: the seller cannot supply it — there is no parameter
-- for it either — and 0009's `tg_set_updated_at` trigger maintains it, exactly as it does for every other
-- write to this table. "Immutable" means the caller cannot choose it; a row whose `updated_at` never moved
-- would make the audit trail a lie.
--
-- **Three states per field, said explicitly.** A partial update has to distinguish "leave this alone" from
-- "set this to nothing", and a single nullable parameter cannot: `null` would mean both. So every field
-- takes a pair — a `p_set_*` flag and a value — and the flag is what decides:
--
--   * `p_set_x = false` → the column keeps its current value, whatever the value parameter holds;
--   * `p_set_x = true` with a value → the column becomes that value;
--   * `p_set_x = true` with `null` → the column is cleared, and only where 0009 allows null.
--
-- `display_name` and `country_code` are `not null` in the table, so clearing them is refused here rather
-- than left to the constraint. Nineteen parameters is verbose; a JSON patch would be shorter and would
-- also be a function that can assign to any column it is handed, which is precisely the thing this must
-- not be. There is no dynamic SQL anywhere below.
--
-- **Who may edit, and when.** The owner is the first parameter and comes from the verified session; the
-- UPDATE's `where` clause names that account and no other, so a cross-seller edit is not refused so much
-- as unexpressible. A `suspended` or `closed` storefront answers `not_editable` and is not written to —
-- and that answer carries no reason, no moderation note and no timestamp, because a seller who has been
-- suspended already knows they have been, and the *why* is not this function's to disclose.
--
-- **Every limit is 0009's**, the same ones 0058 applies, read off the same table: the display-name 2..80
-- on the trimmed value, the bio 2000, `content_language` present in `public.locales`, a country that
-- exists and is marketplace-enabled (D17, re-checked by 0009's own trigger on UPDATE as well as INSERT),
-- and the E.164 phone pattern. The contact e-mail keeps 0058's minimal floor, for the same reason: the
-- column is `citext` with no format constraint, so there is no existing limit to reuse and the API's
-- strict contract is the authoritative gate.
--
-- **What it does not do.** It changes no state, assigns no role, submits nothing for verification, uploads
-- nothing, notifies nobody and creates no second audit path — 0009's `seller_profiles_audit` trigger fires
-- on UPDATE exactly as it fires on INSERT, and records the changed columns itself.
--
-- **Contact fields carry no verification semantics here, and 6-D does not give them any.** `contact_email`
-- and `contact_phone_e164` are storefront details on `public.seller_profiles`; the account's own e-mail and
-- phone live with the provider and are changed only through F4's verified flow, which touches neither of
-- these columns. Nothing in this file reads, writes or invalidates `seller_verifications`, and
-- `verification_status` is immutable above, so editing a storefront's contact details cannot move an
-- account's verification state in either direction.

-- ---------------------------------------------------------------------------------------------------
-- Editing the caller's own storefront
-- ---------------------------------------------------------------------------------------------------
-- Outcomes:
--
--   * `updated`      — the storefront now holds the new values. The row's committed state is returned, so
--                      a surface renders what was stored rather than what was sent.
--   * `not_found`    — this account has no storefront. The same answer 0057 gives by returning no row.
--   * `not_editable` — the storefront is suspended or closed. One outcome for both, saying only that the
--                      profile cannot be edited in its current state; the state itself is already readable
--                      through 0057, and the reason for it is not.
--   * `invalid`      — the request does not satisfy 0009's constraints. One outcome for all of them, for
--                      the same reason 0058 gives one: which field failed is established by the API's
--                      strict contract before the request arrives, and naming a constraint here would be
--                      describing the schema to whoever asked.
create or replace function app_private.seller_update_profile(
  p_user_id uuid,
  p_set_display_name boolean,
  p_display_name text,
  p_set_legal_name boolean,
  p_legal_name text,
  p_set_bio boolean,
  p_bio text,
  p_set_content_language boolean,
  p_content_language text,
  p_set_country_code boolean,
  p_country_code text,
  p_set_governorate boolean,
  p_governorate text,
  p_set_city boolean,
  p_city text,
  p_set_contact_email boolean,
  p_contact_email text,
  p_set_contact_phone_e164 boolean,
  p_contact_phone_e164 text
) returns table (
  outcome text,
  slug text,
  display_name text,
  status text,
  verification_status text,
  city text,
  country_code char(2)
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  -- Everything the function returns lives in a local first, so the final SELECT reads no table and the OUT
  -- parameter names above can never be mistaken for columns.
  v_outcome text;
  v_slug text;
  v_display_name text;
  v_status text;
  v_verification text;
  v_city text;
  v_country char(2);
  v_current_status text;
  -- The normalised values, computed once, used only where their `p_set_*` flag is true.
  v_new_display_name text;
  v_new_legal_name text;
  v_new_bio text;
  v_new_governorate text;
  v_new_city text;
  v_new_email text;
  v_new_phone text;
  v_new_country char(2);
begin
  if p_user_id is null then
    return query select 'not_found'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;

  -- The caller's own storefront, and the gate on its state. Read before anything is validated so that a
  -- suspended seller gets the same answer whatever they sent: a refusal that depended on the body would
  -- tell them which of their fields the system considered acceptable.
  select s.status into v_current_status
    from public.seller_profiles s
   where s.user_id = p_user_id;

  if v_current_status is null then
    return query select 'not_found'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;

  if v_current_status not in ('pending', 'active') then
    return query select 'not_editable'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;

  -- Validation. Each block runs only when its field is actually being set, so a request that touches one
  -- field is never refused because of another it did not mention.
  if p_set_display_name then
    -- `not null` in the table: it can be changed, never cleared.
    if p_display_name is null then
      return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
      return;
    end if;
    v_new_display_name := btrim(p_display_name);
    -- `seller_profiles_display_name_length`: 2..80 on the trimmed value.
    if length(v_new_display_name) < 2 or length(v_new_display_name) > 80 then
      return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
      return;
    end if;
  end if;

  if p_set_legal_name then
    v_new_legal_name := nullif(btrim(coalesce(p_legal_name, '')), '');
  end if;

  if p_set_bio then
    v_new_bio := nullif(btrim(coalesce(p_bio, '')), '');
    -- `seller_profiles_bio_length`.
    if v_new_bio is not null and length(v_new_bio) > 2000 then
      return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
      return;
    end if;
  end if;

  if p_set_content_language then
    -- A foreign key onto `public.locales`; existence is the constraint, so existence is what is checked.
    if p_content_language is not null
       and not exists (select 1 from public.locales l where l.code = p_content_language) then
      return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
      return;
    end if;
  end if;

  if p_set_country_code then
    -- `not null` in the table, and D17: it must exist and be marketplace-enabled. Answered as an outcome
    -- rather than left to 0009's trigger, which raises on UPDATE exactly as it does on INSERT.
    if p_country_code is null or length(p_country_code) <> 2 then
      return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
      return;
    end if;
    if not exists (
      select 1 from public.countries c
       where c.code = p_country_code::char(2) and c.is_marketplace_enabled
    ) then
      return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
      return;
    end if;
    v_new_country := p_country_code::char(2);
  end if;

  if p_set_governorate then
    v_new_governorate := nullif(btrim(coalesce(p_governorate, '')), '');
  end if;

  if p_set_city then
    v_new_city := nullif(btrim(coalesce(p_city, '')), '');
  end if;

  if p_set_contact_email then
    v_new_email := nullif(btrim(coalesce(p_contact_email, '')), '');
    -- 0058's floor beneath the API's strict contract: 0009 constrains this column's type and nothing else.
    if v_new_email is not null
       and (length(v_new_email) > 320 or v_new_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
      return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
      return;
    end if;
  end if;

  if p_set_contact_phone_e164 then
    v_new_phone := nullif(btrim(coalesce(p_contact_phone_e164, '')), '');
    -- `seller_profiles_phone_format`.
    if v_new_phone is not null and v_new_phone !~ '^\+[1-9][0-9]{6,14}$' then
      return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
      return;
    end if;
  end if;

  -- The write. Nine columns may be assigned and no others appear: `slug`, `status`, `verification_status`,
  -- the suspension and closure columns, the verification timestamp and `created_at` are absent from this
  -- statement entirely, and `user_id` appears only in the `where` clause that scopes the row to its owner.
  begin
    update public.seller_profiles as s
       set display_name = case when p_set_display_name then v_new_display_name else s.display_name end,
           legal_name = case when p_set_legal_name then v_new_legal_name else s.legal_name end,
           bio = case when p_set_bio then v_new_bio else s.bio end,
           content_language = case when p_set_content_language then p_content_language else s.content_language end,
           country_code = case when p_set_country_code then v_new_country else s.country_code end,
           governorate = case when p_set_governorate then v_new_governorate else s.governorate end,
           city = case when p_set_city then v_new_city else s.city end,
           contact_email = case
             when p_set_contact_email then v_new_email::extensions.citext
             else s.contact_email
           end,
           contact_phone_e164 = case
             when p_set_contact_phone_e164 then v_new_phone
             else s.contact_phone_e164
           end
     where s.user_id = p_user_id
    returning s.slug, s.display_name, s.status, s.verification_status, s.city, s.country_code
      into v_slug, v_display_name, v_status, v_verification, v_city, v_country;
  exception
    when check_violation or foreign_key_violation or restrict_violation or invalid_text_representation
      or unique_violation then
      -- The constraints are still the authority. Anything they refuse that the checks above let through is
      -- a gap in those checks, and it answers as an ordinary validation failure rather than a 500.
      return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
      return;
  end;

  if v_slug is null then
    -- The row disappeared between the status read and the write. Not an error: the same `not_found` the
    -- caller would have got a moment earlier.
    return query select 'not_found'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;

  v_outcome := 'updated';
  return query select v_outcome, v_slug, v_display_name, v_status, v_verification, v_city, v_country;
end;
$$;
comment on function app_private.seller_update_profile(
  uuid, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text,
  boolean, text, boolean, text, boolean, text, boolean, text
) is
  'Updates the calling account''s own seller profile. Nine editable columns, each with its own set-flag so that an omitted field preserves its value and an explicit null clears it where 0009 allows null. The owner is the first parameter and comes from the verified session, and the update is scoped to that account alone. slug, status, verification_status, the suspension and closure columns, verified_at and created_at appear in no assignment and have no parameter, so none of them can be changed; updated_at is maintained by 0009''s trigger. A suspended or closed storefront answers not_editable without a reason. Refusals are outcome strings only: never a constraint name, a column name or SQL. Touches no verification record and changes no state.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
-- S8 unchanged: one named function, PUBLIC revoked, `app_system` only. `authenticated` gains nothing — its
-- existing owner-write policies on `public.seller_profiles` stay exactly as 0009 wrote them, as defence in
-- depth beneath a path that no longer goes through them — and `anon` gains nothing at all. No table
-- privilege is granted anywhere by this migration.
revoke execute on function app_private.seller_update_profile(
  uuid, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text,
  boolean, text, boolean, text, boolean, text, boolean, text
) from public;
grant execute on function app_private.seller_update_profile(
  uuid, boolean, text, boolean, text, boolean, text, boolean, text, boolean, text,
  boolean, text, boolean, text, boolean, text, boolean, text
) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
