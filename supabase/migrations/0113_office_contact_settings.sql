-- 0113 — The office's own contact details, and the first maintained path to `site_settings`.
--
-- Two gaps close here, and they are the same gap seen from two ends.
--
-- The public one: the site's footer has nowhere to get a telephone number, an address or an office hour from,
-- so it shows none, and a property office whose website does not say how to reach it is not finished. The
-- console one: `public.site_settings` has existed since 0008 with its key, its typed value, its `is_public`
-- flag and its audit trigger, and in five phases nothing has ever been able to write to it. `app_system` holds
-- no table privileges, so the only way a value has ever changed is direct SQL against the database — which is
-- exactly the state 0096 found `seo_settings` in and fixed the same way.
--
-- WHAT THIS ADDS
--
--   1. Eight `site_settings` rows under a new `office` category, every one of them `is_public`, carrying
--      **empty strings** rather than invented values.
--   2. Three named definer functions — the permission test, the staff reader, the staff writer — modelled on
--      0096's exactly, because this is the same problem.
--   3. One public reader, because unlike 0096 these settings exist to be shown.
--
-- **No table, column, constraint, index, trigger or policy is created or changed.** The settings schema is
-- 0008's and stays 0008's. No new permission key is invented either: `settings.site.manage` is seeded by 0033
-- and is precisely this capability.
--
-- WHY THE SEEDED VALUES ARE EMPTY
--
-- A plausible-looking telephone number is worse than no telephone number: it ships, it looks finished, and
-- somebody rings it. An empty value is read by the public reader as "not set" and the footer renders nothing
-- for it — so the site is honest until the office fills it in, and complete the moment it does. The same
-- reasoning 0033 applies to `branding.site_domain`, which it seeds as `localhost` and marks in its own
-- description as a value the owner replaces.
--
-- The descriptions are what the console shows beside each field, so they say what the value is for rather
-- than restating its key.
--
-- WHY `is_public` IS TRUE FOR ALL EIGHT, AND WHAT THAT MEANS
--
-- These are the details of a shop front: they are printed on the door. `is_public` is the flag 0008 defined
-- for exactly this — "settings the public site may read" — and the public reader below returns **only** rows
-- carrying it, by a predicate rather than by a list. A setting that must not be public therefore cannot be
-- served by this reader even if somebody later adds it to the `office` category, which is the property worth
-- having: the next setting anyone adds here is private by default, because `is_public` defaults to false.
--
-- That also settles where a secret may not go. A provider key, a token or a password is not a candidate for
-- this table at all — it is audited, it is read back to the console in full, and its whole purpose is values
-- that are shown. When the search increment needs an API key, that key gets storage of its own.

-- ---------------------------------------------------------------------------------------------------
-- 1. The rows
-- ---------------------------------------------------------------------------------------------------
-- Keys are `office.*` under the `office` category, matching the shape 0008's `site_settings_key_format`
-- requires and the convention 0021, 0023, 0028, 0033 and 0070 already follow.
insert into public.site_settings (key, category, value, value_type, is_public, description_en, description_ar)
values
  ('office.telephone', 'office', '""'::jsonb, 'string', true,
   'The office telephone number, shown in the footer and on the contact page. Empty until the office sets it.',
   'رقم تليفون المكتب، ويظهر في الفوتر وفي صفحة اتصل بنا. فاضي لحد ما المكتب يحطه.'),
  ('office.whatsapp', 'office', '""'::jsonb, 'string', true,
   'The office WhatsApp number, where it differs from the telephone. Empty until the office sets it.',
   'رقم واتساب المكتب، لو مختلف عن التليفون. فاضي لحد ما المكتب يحطه.'),
  ('office.email', 'office', '""'::jsonb, 'string', true,
   'The address enquiries should reach when somebody writes rather than calls. Empty until the office sets it.',
   'البريد اللي توصله الاستفسارات لما حد يكتب بدل ما يتصل. فاضي لحد ما المكتب يحطه.'),
  ('office.address_en', 'office', '""'::jsonb, 'string', true,
   'The office address in English, as it should be read by somebody finding their way there.',
   'عنوان المكتب بالإنجليزي، بالشكل اللي يقرأه حد بيدوّر عليه.'),
  ('office.address_ar', 'office', '""'::jsonb, 'string', true,
   'The office address in Arabic. Both addresses are stored, because this is not a string to translate automatically.',
   'عنوان المكتب بالعربي. العنوانين الاتنين بيتخزنوا، لأن ده مش نص يتترجم آليًا.'),
  ('office.hours_en', 'office', '""'::jsonb, 'string', true,
   'When the office is open, in English. One line, as it would be written on the door.',
   'مواعيد العمل بالإنجليزي. سطر واحد، زي ما تتكتب على الباب.'),
  ('office.hours_ar', 'office', '""'::jsonb, 'string', true,
   'When the office is open, in Arabic.',
   'مواعيد العمل بالعربي.'),
  ('office.social_links', 'office', '[]'::jsonb, 'json', true,
   'The office social accounts, as a list of {"label","url"} objects. Empty until the office adds one.',
   'حسابات المكتب على السوشيال، كقائمة من عناصر {"label","url"}. فاضية لحد ما المكتب يضيف.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------------------
-- 2. The permission test
-- ---------------------------------------------------------------------------------------------------
-- `settings.site.manage`, seeded by 0033. One key for the whole surface, exactly as 0096 reasons: 0033 seeds
-- no paired read key, so a caller either holds the manage key and sees the settings or holds nothing here and
-- sees nothing. The key is a literal and no role name is tested anywhere.
create or replace function app_private.site_settings_can_manage(
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
       and rp.permission_key = 'settings.site.manage'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.site_settings_can_manage(uuid, boolean) is
  'Whether one account effectively holds settings.site.manage — the key as a literal, with 0003''s own requires_mfa rule applied to the assurance level as a parameter. 0033 seeds no settings.site.read, so reading and writing a site setting are the same capability. No role name is tested anywhere.';

-- ---------------------------------------------------------------------------------------------------
-- 3. The staff reader
-- ---------------------------------------------------------------------------------------------------
-- One category at a time, because the console edits a category at a time and reading every setting on the
-- platform to render one screen is how a settings page becomes a place nobody can find anything.
--
-- The permission is tested in the WHERE clause, so a caller without the key reads nothing rather than being
-- told which categories exist.
create or replace function app_private.site_settings_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_category text
) returns table (
  key text,
  category text,
  value jsonb,
  value_type text,
  is_public boolean,
  description_en text,
  description_ar text,
  updated_by uuid,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select s.key, s.category, s.value, s.value_type, s.is_public,
         s.description_en, s.description_ar, s.updated_by, s.updated_at
    from public.site_settings s
   where s.category = nullif(btrim(coalesce(p_category, ''), E' \t\r\n'), '')
     and app_private.site_settings_can_manage(p_user_id, p_is_aal2)
   order by s.key;
$$;

comment on function app_private.site_settings_for_staff(uuid, boolean, text) is
  'One category of site settings, key order, for a caller holding settings.site.manage. No row at all for anybody else. A category at a time, because that is the unit a console screen edits.';

-- ---------------------------------------------------------------------------------------------------
-- 4. The staff writer
-- ---------------------------------------------------------------------------------------------------
-- Writes the value of **one existing setting**. It deliberately cannot create one, and that is the whole
-- safety property of this function: a key, its type, its category and its `is_public` flag are decisions made
-- in a migration where they can be reviewed, not in a text box. A console that could mint settings would be a
-- console that could mint a public setting.
--
-- The value arrives as `jsonb` and the type is checked here as well as by 0008's own
-- `site_settings_value_matches_type`, so a mismatch is a false return rather than an exception crossing the
-- API boundary as a 500.
--
-- Nothing here touches the 8-B attribution channel: `updated_by` is a column of the row, exactly as 0096's
-- writer treats it.
create or replace function app_private.site_setting_save_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_key text,
  p_value jsonb
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_key text;
  v_type text;
  v_matches boolean;
begin
  if not app_private.site_settings_can_manage(p_user_id, p_is_aal2) then
    raise exception 'settings.site.manage is required' using errcode = 'insufficient_privilege';
  end if;

  select s.key, s.value_type into v_key, v_type
    from public.site_settings s
   where s.key = nullif(btrim(coalesce(p_key, ''), E' \t\r\n'), '');

  -- An unknown key is an absence, not an error: the caller asked to change something that does not exist, and
  -- creating it here is the thing this function must not do.
  if v_key is null then
    return false;
  end if;

  v_matches := case v_type
    when 'string' then jsonb_typeof(p_value) = 'string'
    when 'number' then jsonb_typeof(p_value) = 'number'
    when 'boolean' then jsonb_typeof(p_value) = 'boolean'
    else jsonb_typeof(p_value) in ('object', 'array')
  end;

  if p_value is null or not v_matches then
    return false;
  end if;

  update public.site_settings
     set value = case
           -- A string setting is stored trimmed, so a value that is nothing but spaces is stored as the empty
           -- string and read by every consumer as "not set". The character set is explicit, which is 0105's
           -- rule for every `btrim` in this repository.
           when v_type = 'string' then to_jsonb(btrim(p_value #>> '{}', E' \t\r\n'))
           else p_value
         end,
         updated_by = p_user_id
   where key = v_key;

  return true;
end;
$$;

comment on function app_private.site_setting_save_for_staff(uuid, boolean, text, jsonb) is
  'Writes one existing site setting''s value. It cannot create a setting: a key, its type, its category and its is_public flag are migration decisions, not console input. False, and no write, for an unknown key or a value whose JSON type does not match the setting''s declared type. A string value is trimmed with an explicit character set (0105), so whitespace alone is stored as empty and read as unset.';

-- ---------------------------------------------------------------------------------------------------
-- 5. The public reader
-- ---------------------------------------------------------------------------------------------------
-- This is where this migration differs from 0096: these settings exist to be shown, so the public side gets a
-- reader of its own.
--
-- **It returns public settings and nothing else**, by the `is_public` predicate rather than by a list of keys.
-- That is the property worth having: `is_public` defaults to false in 0008, so a setting somebody adds to this
-- category tomorrow is private unless the migration adding it says otherwise, and this reader cannot leak it.
--
-- **And it returns nothing that is empty.** A setting that has never been filled in is absent from the result
-- rather than present as an empty string, so a surface rendering these does not have to decide what an empty
-- string means — if it is in the result it has a value. That is what lets the footer render only the rows the
-- office has actually set.
create or replace function app_private.public_site_settings(p_category text)
returns table (key text, value jsonb)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select s.key, s.value
    from public.site_settings s
   where s.is_public
     and s.category = nullif(btrim(coalesce(p_category, ''), E' \t\r\n'), '')
     -- Empty is absent. A string of nothing, an empty array and an empty object are all "not set yet".
     and case s.value_type
           when 'string' then btrim(s.value #>> '{}', E' \t\r\n') <> ''
           when 'json' then s.value not in ('[]'::jsonb, '{}'::jsonb)
           else true
         end
   order by s.key;
$$;

comment on function app_private.public_site_settings(text) is
  'The public settings of one category that actually have a value. Public by the is_public predicate rather than by a key list, so a setting added later is private unless its own migration says otherwise. An empty string, an empty array and an empty object are returned as absent, so a caller that receives a row knows it has something to show.';

-- ---------------------------------------------------------------------------------------------------
-- 6. Privileges
-- ---------------------------------------------------------------------------------------------------
-- A new function in `app_private` is executable by `public` until it is not: `alter default privileges`
-- revokes it in `public` and `audit`, and this schema is covered by the sweep rather than by a default. The
-- security contract asserts the end state, and this block is what satisfies it.
revoke execute on all functions in schema app_private from public;

revoke execute on function app_private.site_settings_can_manage(uuid, boolean) from public, app_worker;
revoke execute on function app_private.site_settings_for_staff(uuid, boolean, text) from public, app_worker;
revoke execute on function app_private.site_setting_save_for_staff(uuid, boolean, text, jsonb) from public, app_worker;
revoke execute on function app_private.public_site_settings(text) from public, app_worker;

-- `app_system` only, for all four. The worker has no business with these: it reads no setting this migration
-- adds, writes none, and reacts to no event. The public reader is `app_system`'s too — the browser reaches it
-- through the API like every other public read, never directly.
grant execute on function app_private.site_settings_can_manage(uuid, boolean) to app_system;
grant execute on function app_private.site_settings_for_staff(uuid, boolean, text) to app_system;
grant execute on function app_private.site_setting_save_for_staff(uuid, boolean, text, jsonb) to app_system;
grant execute on function app_private.public_site_settings(text) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- 7. Assertions
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  v_rows integer;
  v_private integer;
  v_filled integer;
  v_tables integer;
begin
  select count(*) into v_rows from public.site_settings where category = 'office';
  if v_rows <> 8 then
    raise exception 'expected 8 office settings, found %', v_rows;
  end if;

  select count(*) into v_private from public.site_settings where category = 'office' and not is_public;
  if v_private > 0 then
    raise exception '% office setting(s) are not public; the footer could not read them', v_private;
  end if;

  -- Nothing was invented. Every one of the eight ships empty, and the public reader therefore returns none of
  -- them until the office fills them in.
  select count(*) into v_filled from app_private.public_site_settings('office');
  if v_filled <> 0 then
    raise exception 'an office setting shipped with a value; % returned by the public reader', v_filled;
  end if;

  -- The permission key is 0033's, not a new one.
  if not exists (select 1 from public.permissions where key = 'settings.site.manage') then
    raise exception 'settings.site.manage is missing; this migration must not invent it';
  end if;

  -- No table was created or dropped by this migration.
  select count(*) into v_tables from pg_tables where schemaname = 'public' and tablename = 'site_settings';
  if v_tables <> 1 then
    raise exception 'site_settings is not where 0008 left it';
  end if;
end;
$$;

-- The contract this repository will not ship without.
select app_private.assert_security_contract();
