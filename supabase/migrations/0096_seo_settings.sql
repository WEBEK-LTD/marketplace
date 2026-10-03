-- 0096 — Site-wide SEO settings: the named definer functions that finally let an operator maintain them.
--
-- `public.seo_settings` has existed since 0030 with its eight columns, its five constraints, its `updated_at`
-- trigger, its audit trigger and its two RLS policies. 0086 gave one of those columns a reader. 0091 said in its
-- own header why it stopped short of the rest — *"`seo_settings` gets no functions. The site-wide defaults are a
-- separate cluster behind a separate seeded key"* — and the contract for the robots document has carried the
-- consequence in plain words ever since: *"`seo_settings` ships with no rows and the console that would write
-- them is not built"*. This migration builds it.
--
-- **No table, column, constraint, index, trigger or policy is created or changed, and no new table exists after
-- it.** The settings schema is 0030's and stays 0030's.
--
-- **This migration adds no public reader.** `/robots.txt` already has one — `app_private.public_robots_body()`
-- from 0086 — and that function is not touched, redefined or wrapped here. The other six columns stay stored and
-- unread, each by an explicit owner decision recorded below. Authoring is this increment; consuming is not.
--
-- ---------------------------------------------------------------------------------------------------
-- WHY THIS IS A WRITER-ONLY INCREMENT
-- ---------------------------------------------------------------------------------------------------
--
-- `/robots.txt` is a live crawler-facing document and the only way to change it today is direct SQL against the
-- database. That is the gap. The fix is a maintained path to the column — not new consumption of the other six,
-- which would change what every page tells a crawler and is a separate decision nobody has made.
--
-- The owner decisions this migration is built to:
--
--   1. **`site_name`** — stored and administered only. The public header's source and every page title's source
--      are untouched by this migration; nothing here is read by a public surface.
--   2. **`default_meta_title` / `default_meta_description`** — stored and administered only. Not wired into any
--      metadata resolver. Their future fallback behaviour is a separate, explicitly approved change.
--   3. **`twitter_site`** — stored and administered only. No Twitter metadata is emitted.
--   4. **`organization_structured_data`** — stored and administered only. No JSON-LD and no structured data of any
--      kind is emitted, no schema.org shape is invented, and nothing here depends on an absolute origin. The same
--      reasoning 0091 recorded for `seo_metadata.structured_data`, and the same answer.
--   5. **A non-default locale's `robots_txt_body`** — storable, and reported as **not served**. `robots.txt` is one
--      document at the root of an origin, so 0086 reads the default locale's row and only that row. See the next
--      section: that is enforced structurally here, not by convention.
--   6. **One key.** The whole section is gated on the seeded `seo.settings.manage`. There is no
--      `seo.settings.read` — 0033 seeds no such key and this migration invents none — so whoever can reach this
--      surface may change it, and the readers below test the manage key.
--   7. **A locale's row may be deleted**, which returns the authored state to "nothing authored" — for the robots
--      document, exactly the zero-row answer 0086 already handles by serving a minimal correct document.
--   8. **`default_share_media_id`** — storable, and reported with the stored identifier and its relative object
--      path. Nothing here builds an absolute URL, signs one, or creates any media-origin behaviour.
--
-- ---------------------------------------------------------------------------------------------------
-- THE ONE INVARIANT THAT HAD TO BE MADE STRUCTURAL
-- ---------------------------------------------------------------------------------------------------
--
-- **A non-default locale cannot affect the served robots document.** It is already true, and it is true for a
-- reason worth stating rather than assuming: `app_private.public_robots_body()` joins `public.locales` and filters
-- on `l.is_default`, and `locales_one_default` makes that predicate select at most one row. So the shape of the
-- query — not a rule anybody remembers — is what keeps an Arabic row out of `/robots.txt`.
--
-- This migration therefore does three things about it, none of which changes 0086:
--
--   * it never writes `locales.is_default`, and touches no row of `public.locales` at all;
--   * `seo_settings_for_staff` **computes** whether a locale's body is the served one, from `locales.is_default`,
--     so the console reports the fact rather than restating it as a label somebody has to keep in step;
--   * the pgTAP suite asserts the isolation directly: a body authored on `ar` while `en` has none leaves
--     `public_robots_body()` returning no row at all, and a body authored on both returns the English one.
--
-- ---------------------------------------------------------------------------------------------------
-- WHICH LOCALES THIS SURFACE SHOWS, AND WHY IT STARTS FROM `locales`
-- ---------------------------------------------------------------------------------------------------
--
-- `seo_settings` is keyed by locale and ships empty, so a reader that started from the settings table would show
-- an operator nothing and give them nowhere to type. The staff reader therefore starts from `public.locales` and
-- left-joins the settings, returning **one row per active locale whether or not it has been authored**, with
-- `is_authored` saying which. That is what makes the first save possible.
--
-- "Active" is `locales.is_active`, which is the column that decides whether a locale is part of the site at all;
-- 0030's own `locales_default_is_active` already treats activity as governing. The writer applies the same scope,
-- so this surface cannot store settings for a locale it will never show.
--
-- ---------------------------------------------------------------------------------------------------
-- WHAT A SAVE MEANS
-- ---------------------------------------------------------------------------------------------------
--
-- A save is a **replace of one locale's row**, exactly as 0091's metadata writer is: creating and replacing are
-- one request, because an operator editing a field does not care which, and two endpoints would mean a console
-- having to find out first. An omitted optional field is therefore stored as absent, not left alone — the console
-- sends the form, and the form is the row.
--
-- `site_name` is the one required field, because 0030 declares it `not null`. Every rule about what may be stored
-- stays 0030's: the 1–120 site name, the 70-character default title, the 320-character default description, the
-- `^@[A-Za-z0-9_]{1,15}$` handle and `organization_structured_data` being a JSON object are its five constraints,
-- and a value they refuse arrives at the caller as the refusal the database made.
--
-- **A blank text field is stored as absent rather than as an empty string**, so no surface could ever carry an
-- empty tag — the same treatment 0091 gives its text columns. The robots body is the one field whose interior is
-- never touched: it is served to crawlers verbatim, so only surrounding whitespace is trimmed, and a body that is
-- nothing but whitespace is stored as absent rather than as a document that silently says nothing.
--
-- ---------------------------------------------------------------------------------------------------
-- PERMISSIONS
-- ---------------------------------------------------------------------------------------------------
--
-- One seeded key, from 0033, pinned here as a literal, with 0003's own `requires_mfa` rule applied to the
-- assurance level as a parameter: `seo.settings.manage`. It is not invented, granted or assigned here, and
-- 0030's own `seo_settings_admin_write` policy names exactly it. No role name is tested anywhere in this file.
--
-- ---------------------------------------------------------------------------------------------------
-- AUDIT ATTRIBUTION
-- ---------------------------------------------------------------------------------------------------
--
-- These writers do **not** touch the 8-B attribution channel, exactly as 0085's, 0090's, 0091's and 0095's do
-- not. The actor is recorded where 0030's own schema puts it: `seo_settings.updated_by` is a column of the row,
-- so the audit trigger captures it inside the audited payload.
--
-- ---------------------------------------------------------------------------------------------------
-- WHAT IS NOT HERE
-- ---------------------------------------------------------------------------------------------------
--
-- **`public.site_settings` gets no functions.** It is a different table behind different keys, and its rows are
-- operational policy that writers read — including the settlement posting flag, which is frozen. Nothing in this
-- file reads it, writes it, or names one of its keys.
--
-- **No banner, no media origin, no signed URL, no sitemap change, no new public route, no revalidation consumer,
-- and nothing financial.** No function here reads a promotion, a placement, a wallet, a ledger, a payout, a
-- payment, a settlement or any `finance.*` setting.

-- ---------------------------------------------------------------------------------------------------
-- 1. The permission predicate
-- ---------------------------------------------------------------------------------------------------
-- One key for the whole surface (owner decision 6). There is no read key to pair it with: 0033 seeds
-- `seo.settings.manage` and nothing else for this cluster, so a caller either holds the manage key and sees the
-- settings, or holds nothing here and sees nothing. Every function below applies this test itself.
create or replace function app_private.seo_settings_can_manage(
  p_user_id uuid,
  p_is_aal2 boolean
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.user_roles ur
      join public.roles r on r.key = ur.role_key
      join public.role_permissions rp on rp.role_key = r.key
     where ur.user_id = p_user_id
       and ur.revoked_at is null
       and (ur.expires_at is null or ur.expires_at > now())
       and rp.permission_key = 'seo.settings.manage'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.seo_settings_can_manage(uuid, boolean) is
  'Whether one account effectively holds seo.settings.manage — the key as a literal, with 0003''s own requires_mfa rule applied to the assurance level as a parameter. The only key this cluster has: 0033 seeds no seo.settings.read, so reading and writing the site-wide defaults are the same capability. No role name is tested anywhere.';

-- ---------------------------------------------------------------------------------------------------
-- 2. The staff reader
-- ---------------------------------------------------------------------------------------------------
-- One row per **active** locale, authored or not, so that the first save has somewhere to happen. The permission
-- is tested in the WHERE clause, so a caller without the key reads nothing rather than being told that a locale
-- exists.
--
-- `robots_is_served` is the owner-decision-5 marking, and it is **computed from `locales.is_default`** rather
-- than stored or assumed: it answers exactly the question `app_private.public_robots_body()` asks, so the console
-- cannot drift out of step with the document being served. An operator may author a body on the Arabic row; this
-- column is how they are told it will not be served.
--
-- `share_media_object_path` is the relative object path of whatever media row the settings point at, joined
-- exactly as 0085 joins a page cover and 0091 a share image. It is **not a URL**: the `cms-media` bucket is
-- private, nothing here signs anything, and the caller is expected to say so rather than try to render it.
create or replace function app_private.seo_settings_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean
) returns table (
  locale_code text,
  locale_name_en text,
  locale_name_native text,
  is_default_locale boolean,
  is_authored boolean,
  robots_is_served boolean,
  site_name text,
  default_meta_title text,
  default_meta_description text,
  default_share_media_id uuid,
  share_media_object_path text,
  twitter_site text,
  robots_txt_body text,
  organization_structured_data jsonb,
  updated_by uuid,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    l.code,
    l.name_en,
    l.name_native,
    l.is_default,
    s.locale_code is not null,
    -- The served robots document is the default locale's, and only the default locale's. Asked of the same
    -- column 0086's reader filters on, so the two cannot disagree.
    l.is_default,
    s.site_name,
    s.default_meta_title,
    s.default_meta_description,
    s.default_share_media_id,
    media.object_path,
    s.twitter_site,
    s.robots_txt_body,
    s.organization_structured_data,
    s.updated_by,
    s.created_at,
    s.updated_at
    from public.locales l
    left join public.seo_settings s on s.locale_code = l.code
    left join public.cms_media media on media.id = s.default_share_media_id
   where l.is_active
     and app_private.seo_settings_can_manage(p_user_id, p_is_aal2)
   order by l.is_default desc, l.sort_order, l.code;
$$;

comment on function app_private.seo_settings_for_staff(uuid, boolean) is
  'The site-wide SEO defaults, one row per active locale whether or not it has been authored, default locale first. robots_is_served is computed from locales.is_default and is the only locale whose robots body reaches /robots.txt (owner decision 5). share_media_object_path is a relative object path in a private bucket and is never a URL. No row at all for a caller without seo.settings.manage.';

-- ---------------------------------------------------------------------------------------------------
-- 3. The writer
-- ---------------------------------------------------------------------------------------------------
-- A replace of one locale's row. Creating and replacing are one call, against the table's own primary key.
--
-- Returns false, and writes nothing, when `p_locale_code` is not an **active** locale: the reader shows active
-- locales only, so storing settings for any other one would store a row nobody can ever see or correct. The
-- caller reports that as an absence, which is what it is.
--
-- Nothing in this function reads or writes `public.locales`, `public.site_settings`, a promotion, a placement or
-- anything financial, and nothing touches the 8-B attribution channel: `updated_by` is a column of the row.
create or replace function app_private.seo_settings_save_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_locale_code text,
  p_site_name text,
  p_default_meta_title text default null,
  p_default_meta_description text default null,
  p_default_share_media_id uuid default null,
  p_twitter_site text default null,
  p_robots_txt_body text default null,
  p_organization_structured_data jsonb default null
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target_locale text;
begin
  if not app_private.seo_settings_can_manage(p_user_id, p_is_aal2) then
    raise exception 'seo.settings.manage is required' using errcode = 'insufficient_privilege';
  end if;

  select l.code into target_locale
    from public.locales l
   where l.code = nullif(btrim(coalesce(p_locale_code, '')), '')
     and l.is_active;

  if target_locale is null then
    return false;
  end if;

  insert into public.seo_settings (
    locale_code, site_name, default_meta_title, default_meta_description, default_share_media_id,
    twitter_site, robots_txt_body, organization_structured_data, updated_by
  )
  values (
    target_locale,
    -- Required, because 0030 declares the column `not null`. A blank one is refused by 0030's own
    -- `seo_settings_site_name_length`, which is where that rule lives.
    btrim(coalesce(p_site_name, '')),
    nullif(btrim(coalesce(p_default_meta_title, '')), ''),
    nullif(btrim(coalesce(p_default_meta_description, '')), ''),
    p_default_share_media_id,
    nullif(btrim(coalesce(p_twitter_site, '')), ''),
    -- The one field whose interior is never touched: it is served to crawlers verbatim. Surrounding whitespace
    -- is removed and a body that is nothing but whitespace is stored as absent, so an accidental blank document
    -- is "nothing authored" rather than a crawl policy that says nothing. Interior newlines are the author's.
    case when btrim(coalesce(p_robots_txt_body, ''), E' \t\r\n') = '' then null
         else btrim(p_robots_txt_body, E' \t\r\n') end,
    coalesce(p_organization_structured_data, '{}'::jsonb),
    p_user_id
  )
  on conflict (locale_code) do update
    set site_name = excluded.site_name,
        default_meta_title = excluded.default_meta_title,
        default_meta_description = excluded.default_meta_description,
        default_share_media_id = excluded.default_share_media_id,
        twitter_site = excluded.twitter_site,
        robots_txt_body = excluded.robots_txt_body,
        organization_structured_data = excluded.organization_structured_data,
        updated_by = excluded.updated_by;

  return true;
end;
$$;

comment on function app_private.seo_settings_save_for_staff(uuid, boolean, text, text, text, text, uuid, text, text, jsonb) is
  'Writes one locale''s site-wide SEO defaults, creating the row or replacing it. False, and no write, when the locale is not an active locale. A blank text field is stored as absent so no surface could carry an empty tag; the robots body keeps its interior exactly as authored because it is served to crawlers verbatim. Every rule about what may be stored stays in 0030''s five constraints.';

-- ---------------------------------------------------------------------------------------------------
-- 4. The delete
-- ---------------------------------------------------------------------------------------------------
-- Owner decision 7. Withdrawing an authored crawl policy has to be possible, and it is a different act from
-- clearing seven fields one at a time: afterwards the locale is **unauthored**, which for the default locale is
-- the zero-row answer `app_private.public_robots_body()` has handled since 0086 by letting the web app serve a
-- minimal correct document. A real delete, because these are settings rather than a record of an event, and 0030
-- gave this table no history of its own beyond the audit trail the trigger writes.
--
-- **This one does not require the locale to be active, and the asymmetry with the writer is deliberate.** Authoring
-- settings for a locale nobody can see would create a row nobody could ever correct, so the writer refuses it;
-- withdrawing one can only ever return things to "nothing authored", which is the state the platform ships in. So a
-- row that somehow outlives its locale's activity stays removable, and nothing is ever stuck.
create or replace function app_private.seo_settings_delete_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_locale_code text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  deleted integer;
begin
  if not app_private.seo_settings_can_manage(p_user_id, p_is_aal2) then
    raise exception 'seo.settings.manage is required' using errcode = 'insufficient_privilege';
  end if;

  delete from public.seo_settings s
   where s.locale_code = nullif(btrim(coalesce(p_locale_code, '')), '');

  get diagnostics deleted = row_count;
  return deleted = 1;
end;
$$;

comment on function app_private.seo_settings_delete_for_staff(uuid, boolean, text) is
  'Removes one locale''s site-wide SEO defaults, returning false when nothing was authored for it. Afterwards the locale is unauthored — for the default locale that is the zero-row answer 0086 already handles by serving a minimal robots document (owner decision 7).';

-- ---------------------------------------------------------------------------------------------------
-- 5. Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema app_private from public;

revoke execute on function app_private.seo_settings_can_manage(uuid, boolean) from public, app_worker;
revoke execute on function app_private.seo_settings_for_staff(uuid, boolean) from public, app_worker;
revoke execute on function app_private.seo_settings_save_for_staff(uuid, boolean, text, text, text, text, uuid, text, text, jsonb) from public, app_worker;
revoke execute on function app_private.seo_settings_delete_for_staff(uuid, boolean, text) from public, app_worker;

-- `app_system` only. The worker has no business with the site's SEO defaults: it authors nothing on a schedule
-- here and reacts to no event this migration adds.
grant execute on function app_private.seo_settings_can_manage(uuid, boolean) to app_system;
grant execute on function app_private.seo_settings_for_staff(uuid, boolean) to app_system;
grant execute on function app_private.seo_settings_save_for_staff(uuid, boolean, text, text, text, text, uuid, text, text, jsonb) to app_system;
grant execute on function app_private.seo_settings_delete_for_staff(uuid, boolean, text) to app_system;

-- The contract this repository will not ship without.
select app_private.assert_security_contract();
