-- 0058 — Seller onboarding: creating one's own storefront (Phase 6-C).
--
-- One function, and like 0056 it exists for one reason: **the caller may not choose their own state.**
--
-- 0009 already owns the storefront — the table, the slug shape, the display-name and bio lengths, the
-- E.164 phone format, the status and verification vocabularies, the marketplace-enabled-country trigger,
-- the `updated_at` trigger and the audit trigger. Nothing here re-implements any of that. What 0009 does
-- not do, and cannot do, is decide *who* may insert *which* row: `authenticated` holds INSERT on
-- `public.seller_profiles` behind an owner-write policy, which stops a person creating somebody else's
-- storefront but does not stop them creating their own as `active` and `verified`. This function is the
-- gate that makes that impossible.
--
-- **The three things the caller cannot supply.** `user_id` comes from the verified API session and is the
-- function's first parameter; there is no second identity parameter anywhere below, so there is no value
-- a request could carry that would name a different owner. `status` and `verification_status` are not
-- parameters at all — they are literals in the INSERT. A caller cannot ask for `active`, `verified`,
-- `suspended` or `closed`, and cannot ask for them by omission either, because there is nothing to omit.
--
-- **One storefront per user** is the table's own primary key. It is checked before the insert so the
-- ordinary case answers cleanly, and again by catching the violation, so two simultaneous attempts cannot
-- both succeed. The same is true of the slug: `seller_profiles_slug` is a unique index, and a pre-check
-- alone would be a race.
--
-- **What a refusal says.** An outcome string, and never a constraint name, a column name, a SQL fragment
-- or another seller's identifier. `slug_taken` says the public address is unavailable, which is all a
-- person needs and all anybody may learn: it does not say who holds it, or whether the holder's storefront
-- is active, pending or closed.
--
-- **Validation is the table's, restated as outcomes rather than exceptions.** Every limit below is read
-- off 0009: the slug regex and its 3..50 length, display name 2..80 on the trimmed value, bio 2000, the
-- E.164 pattern, `content_language` present in `public.locales`, and a country that exists *and* is
-- marketplace-enabled — the last being the rule 0009's `tg_seller_country_rule` raises as
-- `restrict_violation`, answered here as `invalid` so a form can render it. No limit is invented and none
-- is loosened; the constraints remain in force underneath, and the exception handler proves it by turning
-- anything they still refuse into `invalid` rather than a 500.
--
-- The one gap 0009 leaves is `contact_email`: the column is `citext` with no format constraint, so there
-- is no existing limit to reuse. The check below is deliberately minimal — one `@`, no whitespace, a dot
-- in the domain, and at most 320 characters, which is the repository's existing
-- `LOGIN_IDENTIFIER_MAX_LENGTH` rather than a new number. The strict contract in the API is the
-- authoritative format gate; this is the floor beneath it.
--
-- **What it does not do.** It assigns no role — nothing here writes to `user_roles`, `role_permissions`
-- or `permissions`, and Phase 6 authorization stays `seller_profiles.status`. It creates no verification
-- record, submits no documents, uploads no media, makes no moderation decision, activates nothing and
-- notifies nobody. The audit record is 0009's trigger doing its ordinary job on an INSERT; there is no
-- second audit path.

-- ---------------------------------------------------------------------------------------------------
-- Creating the caller's own storefront
-- ---------------------------------------------------------------------------------------------------
-- Outcomes:
--
--   * `created`    — the storefront now exists, `pending` and `unverified`. The row's own committed
--                    values are returned, so a surface renders what was stored rather than what was sent.
--   * `exists`     — this account already has a storefront. Nothing is written and nothing is replaced;
--                    one profile per user is the primary key, not a policy this function invents.
--   * `slug_taken` — the public address belongs to somebody else. Says nothing about whom.
--   * `invalid`    — the request does not satisfy 0009's constraints. One outcome for all of them: which
--                    field failed is the API's business, established by its own strict contract before
--                    the request ever reaches here, so naming the constraint would add nothing but a
--                    description of the schema.
create or replace function app_private.seller_create_profile(
  p_user_id uuid,
  p_slug text,
  p_display_name text,
  p_legal_name text,
  p_bio text,
  p_content_language text,
  p_country_code text,
  p_governorate text,
  p_city text,
  p_contact_email text,
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
  -- Every value the function returns lives in a local first, so the final SELECT reads no table and the
  -- OUT parameter names above can never be mistaken for columns.
  v_outcome text;
  v_slug text;
  v_display_name text;
  v_status text;
  v_verification text;
  v_city text;
  v_country char(2);
  v_legal_name text;
  v_bio text;
  v_governorate text;
  v_email text;
  v_phone text;
  v_constraint text;
begin
  -- No session, no storefront. Nothing below would be meaningful without an owner.
  if p_user_id is null then
    return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;

  -- Optional free text is trimmed, and an empty field is an absent one: a form submits '' for a box the
  -- person left alone, and storing that as an empty string would make "no legal name" and "a legal name
  -- of nothing" two different states. The slug is deliberately *not* normalised — see below.
  v_legal_name := nullif(btrim(coalesce(p_legal_name, '')), '');
  v_bio := nullif(btrim(coalesce(p_bio, '')), '');
  v_governorate := nullif(btrim(coalesce(p_governorate, '')), '');
  v_city := nullif(btrim(coalesce(p_city, '')), '');
  v_email := nullif(btrim(coalesce(p_contact_email, '')), '');
  v_phone := nullif(btrim(coalesce(p_contact_phone_e164, '')), '');
  v_display_name := btrim(coalesce(p_display_name, ''));

  -- Already a seller. Checked here so the ordinary repeat answers without attempting a write; the same
  -- condition is caught again below, because a pre-check on its own is a race.
  if exists (select 1 from public.seller_profiles s where s.user_id = p_user_id) then
    return query select 'exists'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;

  -- The slug is 0009's own `seller_profiles_slug_format`, character for character: lower case only, 3..50
  -- characters, no leading or trailing hyphen. It is matched as given and never case-folded or trimmed
  -- into shape. A slug becomes a permanent public URL, so `Good-Shop` is refused rather than quietly
  -- turned into something the person did not type — the address they confirm is the address they get.
  if coalesce(p_slug, '') !~ '^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$' then
    return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;
  v_slug := p_slug;

  -- `seller_profiles_display_name_length`: 2..80 on the trimmed value.
  if length(v_display_name) < 2 or length(v_display_name) > 80 then
    return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;

  -- `seller_profiles_bio_length`.
  if v_bio is not null and length(v_bio) > 2000 then
    return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;

  -- `content_language` is a foreign key onto `public.locales`; existence is the constraint, so existence
  -- is what is checked. Nothing here decides which locales a seller may write in.
  if p_content_language is not null
     and not exists (select 1 from public.locales l where l.code = p_content_language) then
    return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;

  -- D17, as 0009's trigger states it: a seller must sit in a country that exists *and* is enabled for the
  -- marketplace. Answered as an outcome rather than left to the trigger's `restrict_violation`, so the
  -- person sees a field to correct instead of a failure. The code is matched exactly — `char(2)` pads and
  -- compares, but it does not case-fold, and inventing a case rule for a foreign key would be inventing.
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
  v_country := p_country_code::char(2);

  -- The floor beneath the API's strict contract: 0009 constrains this column's type and nothing else.
  if v_email is not null
     and (length(v_email) > 320 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
    return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;

  -- `seller_profiles_phone_format`.
  if v_phone is not null and v_phone !~ '^\+[1-9][0-9]{6,14}$' then
    return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;

  -- The state is written as literals. There is no parameter for either column, and no expression below
  -- reads one — which is what makes "the caller cannot create an active or verified storefront" a
  -- property of the function rather than a rule somebody has to remember to check.
  begin
    insert into public.seller_profiles as s (
      user_id, slug, display_name, legal_name, bio, content_language,
      country_code, governorate, city, contact_email, contact_phone_e164,
      status, verification_status
    ) values (
      p_user_id, v_slug, v_display_name, v_legal_name, v_bio, p_content_language,
      v_country, v_governorate, v_city, v_email::extensions.citext, v_phone,
      'pending', 'unverified'
    )
    returning s.status, s.verification_status, s.slug, s.display_name, s.city, s.country_code
      into v_status, v_verification, v_slug, v_display_name, v_city, v_country;
  exception
    when unique_violation then
      -- Which uniqueness, decided from the diagnostic rather than guessed: the primary key is a second
      -- storefront for this account, the slug index is an address somebody else holds. The constraint
      -- name is read here and never returned.
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'seller_profiles_slug' then
        v_outcome := 'slug_taken';
      elsif v_constraint = 'seller_profiles_pkey' then
        v_outcome := 'exists';
      else
        v_outcome := 'invalid';
      end if;
      return query select v_outcome, null::text, null::text, null::text, null::text, null::text, null::char(2);
      return;
    when check_violation or foreign_key_violation or restrict_violation or invalid_text_representation then
      -- The constraints are still the authority. Anything they refuse that the checks above let through
      -- is a gap in those checks, and it answers as an ordinary validation failure rather than a 500.
      return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
      return;
  end;

  -- What committed, read back from the row itself.
  return query select 'created'::text, v_slug, v_display_name, v_status, v_verification, v_city, v_country;
end;
$$;
comment on function app_private.seller_create_profile(
  uuid, text, text, text, text, text, text, text, text, text, text
) is
  'Creates the calling account''s own seller profile, always pending and unverified. The owner is the first parameter and comes from the verified session; status and verification_status are literals, so no caller can create an active, verified, suspended or closed storefront. One profile per user and one holder per slug are enforced by 0009''s primary key and unique index, checked before the insert and caught again on violation. Refusals are outcome strings only: never a constraint name, a column name, SQL, or anything about the account that holds a slug. Assigns no role, creates no verification record, uploads nothing, decides nothing.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
-- S8 unchanged: one named function, PUBLIC revoked, `app_system` only. `authenticated` gains nothing —
-- its existing owner-write policies on `public.seller_profiles` stay exactly as 0009 wrote them, as
-- defence in depth beneath a path that no longer goes through them — and `anon` gains nothing at all. No
-- table privilege is granted anywhere by this migration.
revoke execute on function app_private.seller_create_profile(
  uuid, text, text, text, text, text, text, text, text, text, text
) from public;
grant execute on function app_private.seller_create_profile(
  uuid, text, text, text, text, text, text, text, text, text, text
) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
