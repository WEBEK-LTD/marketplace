-- pgTAP — migration 0113: the office's contact details, and the first maintained path to `site_settings`.
--
-- Three things are asserted, and the third is the one that matters most:
--
--   * the eight rows exist, are public, and **ship empty**, so nothing plausible-looking was invented;
--   * the staff reader and writer are gated on `settings.site.manage` — 0033's key, not a new one — and the
--     writer cannot create a setting, which is the whole safety property of the surface: a key's type,
--     category and `is_public` flag are migration decisions, not console input;
--   * the public reader returns public settings **and only public settings**, by predicate rather than by a
--     list of keys, and returns nothing that has no value. A private setting added to this category later
--     must not become visible because somebody forgot to update a list.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(25);

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('11130000-0000-4000-8000-000000000001', 's-admin@test.invalid'),
  ('11130000-0000-4000-8000-000000000002', 's-nobody@test.invalid');

insert into public.user_roles (user_id, role_key, granted_at) values
  ('11130000-0000-4000-8000-000000000001', 'admin', now() - interval '10 days');

-- ---------------------------------------------------------------------------------------------------
-- 1. The rows, and what they do not claim
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from public.site_settings where category = 'office'),
  8, 'eight office settings');

select is(
  (select count(*)::integer from public.site_settings where category = 'office' and not is_public),
  0, 'all of them public: the footer reads them, and they are the details printed on a shop door');

select is(
  (select count(*)::integer from public.site_settings
    where category = 'office' and value_type = 'string'
      and btrim(value #>> '{}', E' \t\r\n') <> ''),
  0, 'and all of them empty: a plausible telephone number that ships is worse than none, because somebody rings it');

select is(
  (select count(*)::integer from public.site_settings
    where category = 'office' and (length(btrim(description_en, E' \t\r\n')) = 0
                                or length(btrim(description_ar, E' \t\r\n')) = 0)),
  0, 'each describes itself in both languages, which is what the console shows beside the field');

select is(
  (select count(*)::integer from public.site_settings where category = 'office' and key !~ '^office\.'),
  0, 'and every key is under the office prefix');

-- ---------------------------------------------------------------------------------------------------
-- 2. The permission, which is 0033's and not a new one
-- ---------------------------------------------------------------------------------------------------
select ok(
  (select exists (select 1 from public.permissions where key = 'settings.site.manage')),
  'settings.site.manage is seeded by 0033; this migration invented no key');

select ok(
  app_private.site_settings_can_manage('11130000-0000-4000-8000-000000000001', true),
  'an admin at AAL2 can manage site settings');

select ok(
  not app_private.site_settings_can_manage('11130000-0000-4000-8000-000000000002', true),
  'an account with no role cannot');

select ok(
  not app_private.site_settings_can_manage(null, true),
  'and neither can nobody at all');

-- ---------------------------------------------------------------------------------------------------
-- 3. The staff reader
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from app_private.site_settings_for_staff(
     '11130000-0000-4000-8000-000000000001', true, 'office')),
  8, 'the staff reader returns the category');

select is(
  (select count(*)::integer from app_private.site_settings_for_staff(
     '11130000-0000-4000-8000-000000000002', true, 'office')),
  0, 'and nothing at all to a caller without the key — not an error naming what exists');

select is(
  (select count(*)::integer from app_private.site_settings_for_staff(
     '11130000-0000-4000-8000-000000000001', true, 'no_such_category')),
  0, 'an unknown category is an empty result rather than a failure');

select is(
  (select key from app_private.site_settings_for_staff(
     '11130000-0000-4000-8000-000000000001', true, 'office') limit 1),
  'office.address_ar', 'and the rows come back in key order, so the screen does not reshuffle itself');

-- ---------------------------------------------------------------------------------------------------
-- 4. The writer, and the thing it must not be able to do
-- ---------------------------------------------------------------------------------------------------
select ok(
  app_private.site_setting_save_for_staff(
    '11130000-0000-4000-8000-000000000001', true, 'office.telephone', to_jsonb('+20 2 1234 5678'::text)),
  'an admin can set a value');

select is(
  (select value #>> '{}' from public.site_settings where key = 'office.telephone'),
  '+20 2 1234 5678', 'and it is stored');

select is(
  (select updated_by from public.site_settings where key = 'office.telephone'),
  '11130000-0000-4000-8000-000000000001'::uuid, 'with the actor on the row');

select ok(
  app_private.site_setting_save_for_staff(
    '11130000-0000-4000-8000-000000000001', true, 'office.hours_en', to_jsonb('   '::text)),
  'whitespace alone is accepted as a value');

select is(
  (select value #>> '{}' from public.site_settings where key = 'office.hours_en'),
  '', 'and stored as empty, so every consumer reads it as unset rather than as a blank line');

-- **The writer cannot create a setting.** This is the property the whole surface rests on: if the console
-- could mint a key it could mint a *public* key, and `is_public` would stop being a reviewed decision.
select ok(
  not app_private.site_setting_save_for_staff(
    '11130000-0000-4000-8000-000000000001', true, 'office.invented_key', to_jsonb('x'::text)),
  'an unknown key is refused');

select is(
  (select count(*)::integer from public.site_settings where key = 'office.invented_key'),
  0, 'and nothing is created: a key, its type and its is_public flag are migration decisions');

select ok(
  not app_private.site_setting_save_for_staff(
    '11130000-0000-4000-8000-000000000001', true, 'office.telephone', '42'::jsonb),
  'a value whose JSON type does not match the setting is refused rather than raised across the API');

select throws_ok(
  $$ select app_private.site_setting_save_for_staff(
       '11130000-0000-4000-8000-000000000002', true, 'office.telephone', to_jsonb('x'::text)) $$,
  '42501', null,
  'and a caller without the key is refused outright');

-- ---------------------------------------------------------------------------------------------------
-- 5. The public reader
-- ---------------------------------------------------------------------------------------------------
-- One value is set by now — the telephone, from section 4 — and `office.hours_en` was set to whitespace,
-- which is stored empty and must therefore not be served.
select is(
  (select count(*)::integer from app_private.public_site_settings('office')),
  1, 'the public reader returns what has a value and nothing else: empty is absent, not blank');

select is(
  (select key from app_private.public_site_settings('office')),
  'office.telephone', 'and it is the one that was set');

-- The predicate, not a list. A private setting dropped into this category must stay invisible, and the only
-- way to prove that is to put one there.
insert into public.site_settings (key, category, value, value_type, is_public, description_en, description_ar)
values ('office.private_note', 'office', '"not for the footer"'::jsonb, 'string', false,
        'A private setting, for this assertion only.', 'إعداد خاص، لهذا الاختبار فقط.');

select is(
  (select count(*)::integer from app_private.public_site_settings('office')
    where key = 'office.private_note'),
  0, 'a private setting in the same category is never served, because the reader filters on is_public');

select finish();
rollback;
