-- pgTAP — migration 0008: site settings, email templates and the notification outboxes.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(15);

insert into public.locales (code, name_en, name_native, direction, is_active, is_default)
values ('zz', 'Test locale', 'Test locale', 'ltr', true, false);

insert into public.site_settings (key, category, value, value_type, is_public, description_en, description_ar)
-- `branding.site_name` is seeded in 0033 with this same neutral value, so only the setting this test
-- invents for itself is inserted here.
values
  ('security.session_timeout_minutes', 'security', '60'::jsonb, 'number', false, 'Session timeout', 'Session timeout');

-- Settings --------------------------------------------------------------------------------------------
select has_table('public', 'site_settings', 'site_settings exists');
select is(public.site_setting('branding.site_name'), '"Marketplace"'::jsonb, 'a setting can be read by key');
select is(public.site_setting('nope.missing'), null, 'an unknown key reads as NULL');

select throws_ok(
  $$insert into public.site_settings (key, category, value, value_type, description_en, description_ar)
    values ('branding.broken', 'branding', '42'::jsonb, 'string', 'x', 'x')$$,
  '23514',
  null,
  'the stored value must match the declared value type'
);

select throws_ok(
  $$insert into public.site_settings (key, category, value, value_type, description_en, description_ar)
    values ('NotAKey', 'branding', '"x"'::jsonb, 'string', 'x', 'x')$$,
  '23514',
  null,
  'setting keys are dotted lower snake case'
);

-- Email outbox ----------------------------------------------------------------------------------------
create temp table queued as
select app_private.queue_email('buyer@example.test', 'Subject', '<p>Body</p>', 'Body', null, 'order.placed', 'zz', 'dedupe-1') as id;

select isnt((select id from queued), null, 'an email can be queued');
select is(
  app_private.queue_email('buyer@example.test', 'Subject', '<p>Body</p>', 'Body', null, 'order.placed', 'zz', 'dedupe-1'),
  null,
  'the same dedupe key never queues a second email'
);

create temp table claimed_email as select * from app_private.claim_outbox_messages('email', 10);
select is((select count(*) from claimed_email), 1::bigint, 'the sender claims the queued email');
select is((select status from public.email_outbox where id = (select id from queued)), 'sending', 'a claimed email is marked sending');

select ok(
  app_private.settle_outbox_message('email', (select id from queued), 'sent', 'provider-1'),
  'a delivery can be settled as sent'
);
select ok(
  not app_private.settle_outbox_message('email', (select id from queued), 'sent', 'provider-1'),
  'settling the same delivery twice changes nothing'
);

-- WhatsApp outbox (C21: OTP only, and the code is never stored) -----------------------------------------
select throws_ok(
  $$insert into public.whatsapp_outbox (to_phone_e164, purpose, template_name, template_locale)
    values ('+201000000000', 'marketing', 'promo', 'en')$$,
  '23514',
  null,
  'WhatsApp carries OTP messages only in V1'
);

select throws_ok(
  $$insert into public.whatsapp_outbox (to_phone_e164, template_name, template_locale, variables)
    values ('+201000000000', 'otp_code', 'en', '{"code":"123456"}'::jsonb)$$,
  '23514',
  null,
  'the one-time code is never stored in the outbox'
);

select isnt(
  app_private.queue_whatsapp_otp('+201000000000', 'otp_code', 'en', null, '{"expires_in_minutes":10}'::jsonb, 'wa-1'),
  null,
  'an OTP message without secrets can be queued'
);

-- The outboxes are reachable only through the functions above.
select is(
  (select count(*) from information_schema.role_table_grants
    where grantee = 'authenticated' and table_name in ('email_outbox', 'whatsapp_outbox')),
  0::bigint,
  'no application role can touch the outboxes directly'
);

select * from finish();
rollback;
