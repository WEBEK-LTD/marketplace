-- 0050 — Reading one public seller profile by slug (Phase 4-E).
--
-- **Two different questions about one seller.** `public.is_seller_publicly_visible(uuid)` asks "may this
-- seller's listings be shown", and answers yes only for `active`. The profile page asks something else:
-- "does this seller have a public page, and is it live" — and a *suspended* seller does, showing
-- "unavailable". Answering the page's question with the listing helper would 404 every suspended seller,
-- which is exactly what the specification's seller-suspended row forbids.
--
-- So the helper is left untouched — it remains the rule for listings and services, and 0046/0047 keep
-- calling it — and the profile rule is written separately here:
--
--   active     found,     availability = available
--   suspended  found,     availability = unavailable
--   pending    not_found
--   closed     not_found
--   unknown    not_found
--
-- **Pending, closed and unknown are one answer.** Not three answers that happen to share a status code:
-- the function returns the same row for all of them, with every field null, so there is nothing in the
-- response for a caller to tell them apart by. A seller who has applied and not yet been approved must
-- not be discoverable by asking for their slug.
--
-- **The projection is five fields**, and the rest of the table is never read: no `user_id`, no
-- `legal_name`, no `contact_email`, no `contact_phone_e164`, no `verification_status`, no `verified_at`,
-- no `status`, no `suspended_at`, no `suspension_reason`, no `closed_at`, no `country_code`, no
-- `governorate`, no timestamps, and no media paths (variant decisions are still deferred).
--
-- `content_language` travels with the bio because the bio is seller-written content: D7 stores it in its
-- own writing language and never translates it, so a page in Arabic may carry an English bio and needs
-- to say so. There is no locale parameter here at all — nothing in this projection is translated.

create or replace function app_private.public_seller_by_slug(p_slug text)
returns table (
  outcome text,
  availability text,
  slug text,
  display_name text,
  bio text,
  content_language text,
  city text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select case when s.user_id is null then 'not_found' else 'found' end,
         case when s.status = 'active' then 'available' else 'unavailable' end,
         s.slug,
         s.display_name,
         s.bio,
         s.content_language,
         s.city
    from (select 1) one
    -- The join decides visibility: a seller in any other status simply does not join, so every field
    -- below comes back null and the outcome is `not_found`. There is no branch to forget.
    left join public.seller_profiles s
      on s.slug = p_slug and s.status in ('active', 'suspended');
$$;

comment on function app_private.public_seller_by_slug(text) is
  'One public seller profile by slug. Active sellers are available, suspended sellers are unavailable, and pending, closed and unknown sellers are one indistinguishable not_found. Five public fields only: never the seller id, the legal name, contact details, verification state or internal status.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.public_seller_by_slug(text) from public;
grant execute on function app_private.public_seller_by_slug(text) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
