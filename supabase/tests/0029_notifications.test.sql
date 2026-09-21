-- pgTAP — migration 0029: the notification row and its constraints, the immutability of its content,
-- the user's own channel settings, idempotency, the outbox publication, the email link, the read and
-- archive lifecycle, the per-user Realtime topic, and the grants that make forging impossible.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(51);

-- Fixtures ------------------------------------------------------------------------------------------
insert into public.locales (code, name_en, name_native, direction, is_active, is_default)
values ('zz', 'Test locale', 'Test locale', 'ltr', true, false);
insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled, is_default, is_pricing_enabled, is_checkout_enabled)
values ('XTS', '963', 'T', 2, true, false, true, true);
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code, default_currency_code, is_marketplace_enabled)
values ('ZZ', 'ZZZ', '999', 'Enabled', 'Enabled', '999', 'XTS', true);
-- listing_types (`product`, `service`) are seeded reference data in 0033.

insert into auth.users (id, email) values
  ('aaaaaaaa-1111-4111-8111-111111111111', 'seller@example.test'),
  ('bbbbbbbb-2222-4222-8222-222222222222', 'buyer@example.test'),
  ('cccccccc-3333-4333-8333-333333333333', 'quiet@example.test'),
  ('dddddddd-4444-4444-8444-444444444444', 'staff@example.test');

-- 0005 creates a user_settings row with every new account, so these are updates, not inserts.
update public.user_settings set notify_email = true, notify_in_app = true, marketing_opt_in = false
 where user_id = 'bbbbbbbb-2222-4222-8222-222222222222';
update public.user_settings set notify_email = false, notify_in_app = false, marketing_opt_in = false
 where user_id = 'cccccccc-3333-4333-8333-333333333333';

-- Shape and constraints -----------------------------------------------------------------------------
select has_table('public', 'notifications', 'the notifications table exists');
select has_column('public', 'notifications', 'email_outbox_id',
  'and links to the email copy rather than restating its delivery state');

select throws_ok(
  $$insert into public.notifications (user_id, category, event_type, template_key)
    values ('bbbbbbbb-2222-4222-8222-222222222222', 'weather', 'order.paid', 'order.paid')$$,
  '23514',
  null,
  'only the listed categories exist'
);
select throws_ok(
  $$insert into public.notifications (user_id, category, event_type, template_key)
    values ('bbbbbbbb-2222-4222-8222-222222222222', 'orders', 'NotAnEvent', 'order.paid')$$,
  '23514',
  null,
  'an event type has the same shape as the outbox event that caused it'
);
select throws_ok(
  $$insert into public.notifications (user_id, category, event_type, template_key, variables)
    values ('bbbbbbbb-2222-4222-8222-222222222222', 'security', 'account.otp', 'account.otp',
            '{"code":"123456"}'::jsonb)$$,
  '23514',
  null,
  'a display payload can never carry a secret'
);
select throws_ok(
  $$insert into public.notifications (user_id, category, event_type, template_key, action_path)
    values ('bbbbbbbb-2222-4222-8222-222222222222', 'orders', 'order.paid', 'order.paid',
            'https://evil.example/steal')$$,
  '23514',
  null,
  'and can never send a user to another host'
);
select throws_ok(
  $$insert into public.notifications (user_id, category, event_type, template_key, action_path)
    values ('bbbbbbbb-2222-4222-8222-222222222222', 'orders', 'order.paid', 'order.paid',
            '//evil.example/steal')$$,
  '23514',
  null,
  'not even through a protocol-relative path'
);
select throws_ok(
  $$insert into public.notifications (user_id, category, event_type, template_key, origin)
    values ('bbbbbbbb-2222-4222-8222-222222222222', 'orders', 'order.paid', 'order.paid', 'staff')$$,
  '23514',
  null,
  'a staff notification always names its actor'
);
select throws_ok(
  $$insert into public.notifications (user_id, category, event_type, template_key, actor_user_id)
    values ('bbbbbbbb-2222-4222-8222-222222222222', 'orders', 'order.paid', 'order.paid',
            'dddddddd-4444-4444-8444-444444444444')$$,
  '23514',
  null,
  'and a system one never does'
);
select throws_ok(
  $$insert into public.notifications (user_id, category, event_type, template_key, subject_type)
    values ('bbbbbbbb-2222-4222-8222-222222222222', 'orders', 'order.paid', 'order.paid', 'order')$$,
  '23514',
  null,
  'a subject is a type and an id together or neither'
);

-- Creation ------------------------------------------------------------------------------------------------
select throws_ok(
  $$select app_private.create_notification('bbbbbbbb-2222-4222-8222-222222222222', 'orders',
      'order.paid', 'order.paid', '{}'::jsonb, null, null, null, null, false, 'staff')$$,
  '23514',
  null,
  'creating a staff notification without an actor is refused'
);
select throws_ok(
  $$select app_private.create_notification('bbbbbbbb-2222-4222-8222-222222222222', 'orders',
      'order.paid', 'order.paid', '{}'::jsonb, null, null, null, null, false, 'ghost')$$,
  '22023',
  null,
  'and so is an origin that is neither the system nor staff'
);

select lives_ok(
  $$select app_private.create_notification(
      'bbbbbbbb-2222-4222-8222-222222222222', 'orders', 'order.paid', 'orders.paid',
      '{"order_number":"MP-26-001001"}'::jsonb, 'order', '01110001-aaaa-4aaa-8aaa-011100000001',
      '/dashboard/orders/MP-26-001001', 'order:paid:1')$$,
  'a notification is created'
);
select is((select count(*) from public.notifications), 1::bigint, 'exactly one row');
select is(
  (select format('%s/%s/%s', category, origin,
            case when is_marketing then 'marketing' else 'not marketing' end)
     from public.notifications),
  'orders/system/not marketing',
  'which is a system notification by default');
select is(
  (select subject_id from public.notifications),
  '01110001-aaaa-4aaa-8aaa-011100000001'::uuid,
  'carrying a reference to what it is about rather than a copy of it'
);

select is(
  app_private.create_notification(
    'bbbbbbbb-2222-4222-8222-222222222222', 'orders', 'order.paid', 'orders.paid',
    '{}'::jsonb, null, null, null, 'order:paid:1'),
  (select id from public.notifications),
  'the same dedupe key returns the notification already there (C10)'
);
select is((select count(*) from public.notifications), 1::bigint, 'and creates no second row');

-- Publication goes through the outbox, with references only ---------------------------------------------------
select is(
  (select count(*) from public.outbox_events where event_type = 'notification.created'),
  1::bigint,
  'creation publishes through the outbox in the same transaction'
);
select is(
  (select payload ->> 'topic' from public.outbox_events where event_type = 'notification.created'),
  'user:bbbbbbbb-2222-4222-8222-222222222222',
  'on the per-user private topic 0014 already defined'
);
select is(
  (select payload ? 'variables' from public.outbox_events where event_type = 'notification.created'),
  false,
  'and the payload carries the id and display fields, never the variables'
);
select is(
  public.notification_topic('bbbbbbbb-2222-4222-8222-222222222222'),
  public.user_topic('bbbbbbbb-2222-4222-8222-222222222222'),
  'the notification topic is that same topic, not a parallel one'
);

-- The user's own settings decide what is produced ------------------------------------------------------------------
select is(
  app_private.create_notification('cccccccc-3333-4333-8333-333333333333', 'orders', 'order.paid', 'orders.paid'),
  null,
  'a user who turned in-app notifications off gets none'
);
select is(
  app_private.create_notification('bbbbbbbb-2222-4222-8222-222222222222', 'promotions',
    'promotion.offer', 'promotions.offer', '{}'::jsonb, null, null, null, null, true),
  null,
  'and a marketing notification needs the marketing opt-in'
);
select is((select count(*) from public.notifications), 1::bigint,
  'so neither produced a row');

-- The email copy is a link, not a merge ----------------------------------------------------------------------------
select isnt(
  app_private.attach_notification_email((select id from public.notifications),
    'buyer@example.test', 'Your order is paid', '<p>Paid</p>', 'Paid'),
  null,
  'the email copy is queued through 0008''s outbox'
);
select is(
  (select count(*) from public.email_outbox where dedupe_key like 'notification:%'),
  1::bigint,
  'as one email_outbox row keyed on the notification'
);
select isnt(
  (select email_outbox_id from public.notifications),
  null,
  'and the notification links to it'
);
select is(
  app_private.attach_notification_email((select id from public.notifications),
    'buyer@example.test', 'Again', '<p>Again</p>', 'Again'),
  (select email_outbox_id from public.notifications),
  'attaching again returns the email already queued (C10)'
);
select is((select count(*) from public.email_outbox), 1::bigint, 'and queues no second email');
select is(
  (select status from public.email_outbox),
  'queued',
  'the email keeps its own delivery state, separate from the notification'
);

-- A user with email turned off gets no email ---------------------------------------------------------------------------
do $$
declare
  quiet_id uuid;
begin
  update public.user_settings set notify_in_app = true where user_id = 'cccccccc-3333-4333-8333-333333333333';
  quiet_id := app_private.create_notification('cccccccc-3333-4333-8333-333333333333', 'orders',
    'order.paid', 'orders.paid');
  perform app_private.attach_notification_email(quiet_id, 'quiet@example.test', 'S', '<p>B</p>', 'B');
end;
$$;

select is((select count(*) from public.email_outbox), 1::bigint,
  'a user who turned email off gets the in-app row but no email');
select is((select count(*) from public.notifications), 2::bigint,
  'and the in-app row is there');

-- Publication is recorded once ---------------------------------------------------------------------------------------------
select ok(
  app_private.mark_notification_published((select id from public.notifications where dedupe_key = 'order:paid:1')),
  'the worker records that it published'
);
select ok(
  not app_private.mark_notification_published((select id from public.notifications where dedupe_key = 'order:paid:1')),
  'and publishing again records nothing, so the relay is safe to retry'
);

-- Content is fixed; only the state columns move --------------------------------------------------------------------------
select throws_ok(
  $$update public.notifications set user_id = 'aaaaaaaa-1111-4111-8111-111111111111'$$,
  '23001',
  null,
  'the recipient of a notification can never be rewritten'
);
select throws_ok(
  $$update public.notifications set origin = 'staff', actor_user_id = 'dddddddd-4444-4444-8444-444444444444'$$,
  '23001',
  null,
  'nor its sender identity'
);
select throws_ok(
  $$update public.notifications set event_type = 'order.refunded'$$,
  '23001',
  null,
  'nor the system event it claims to be'
);
select throws_ok(
  $$update public.notifications set published_at = now() + interval '1 hour'
      where dedupe_key = 'order:paid:1'$$,
  '23001',
  null,
  'and a published notification cannot be re-announced'
);
select throws_ok(
  $$delete from public.notifications$$,
  '23001',
  null,
  'notifications are archived, never deleted'
);

select lives_ok(
  $$update public.notifications set read_at = now() where dedupe_key = 'order:paid:1'$$,
  'marking one read is allowed'
);
select lives_ok(
  $$update public.notifications set archived_at = now() where dedupe_key = 'order:paid:1'$$,
  'and so is archiving it'
);

-- The grants are what limit a user to those two columns ------------------------------------------------------------------
select is(
  (select count(*) from information_schema.column_privileges
    where grantee = 'authenticated' and table_schema = 'public' and table_name = 'notifications'
      and privilege_type = 'UPDATE'),
  2::bigint,
  'authenticated holds UPDATE on exactly two columns'
);
select is(
  (select string_agg(column_name, ',' order by column_name) from information_schema.column_privileges
    where grantee = 'authenticated' and table_schema = 'public' and table_name = 'notifications'
      and privilege_type = 'UPDATE'),
  'archived_at,read_at',
  'and they are read_at and archived_at');
select is(
  (select count(*) from information_schema.role_table_grants
    where grantee = 'authenticated' and table_schema = 'public' and table_name = 'notifications'
      and privilege_type in ('INSERT', 'DELETE')),
  0::bigint,
  'nobody may insert or delete a notification, so one cannot be forged'
);
select is(
  (select count(*) from information_schema.role_table_grants
    where grantee = 'anon' and table_schema = 'public' and table_name = 'notifications'),
  0::bigint,
  'and anon reaches it not at all'
);

-- Marking read is scoped to its own user ------------------------------------------------------------------------------------
select is(
  app_private.mark_notifications_read('cccccccc-3333-4333-8333-333333333333'),
  1,
  'a user''s own unread notifications are marked read'
);
select is(
  app_private.mark_notifications_read('aaaaaaaa-1111-4111-8111-111111111111'),
  0,
  'and somebody else''s are untouched, because the statement scopes itself to the user'
);

-- The per-user topic stays fail-closed ---------------------------------------------------------------------------------------
select ok(not public.can_join_realtime_topic('user:bbbbbbbb-2222-4222-8222-222222222222'),
  'without a verified claim nobody joins a user topic');
select ok(not public.can_join_realtime_topic('user:not-a-uuid'),
  'and an unparsable one joins nothing');
select is(
  public.unread_notification_count('bbbbbbbb-2222-4222-8222-222222222222'),
  0::bigint,
  'the badge count answers zero for anyone who is not the caller'
);

select * from finish();
rollback;
