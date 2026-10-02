-- pgTAP — Phase 7-D: the email delivery relay, as a composition of objects that already existed.
--
-- **This increment adds no database object.** 0008 created `email_outbox`, `queue_email`,
-- `claim_outbox_messages` and `settle_outbox_message`, and granted the last two to `app_worker`; 0029
-- created `attach_notification_email`, which is the only writer that puts a notification's email into
-- that outbox. 7-D writes the worker that drains it and nothing else, so the first thing this file does
-- is prove that claim rather than assert it: the signatures, the privileges and the role boundary are
-- all checked to be exactly what the earlier migrations left.
--
-- What the rest of it holds to account is the delivery contract the worker depends on, in five groups.
--
-- **The role boundary.** `app_worker` may execute the two outbox functions and holds no privilege of
-- any kind on `email_outbox` itself. That is what makes the store in `apps/worker/src/email` a gateway
-- rather than a convention: a direct read of the table from that role would be refused by the database,
-- not by a code review.
--
-- **What identifies one attempt, and how a row is claimed.** A claim takes only rows that are `queued`
-- and already available, moves them to `sending` and increments `attempts` in the same statement. The
-- counter is therefore the database's, not the worker's, and one attempt is one claim-to-settle cycle.
--
-- **Why a message cannot be processed twice.** A claimed row is no longer `queued`, so a second claim
-- finds nothing; and a settle lands only on a row still in `sending`, so a late duplicate changes
-- nothing and says so by returning false.
--
-- **How failure and retry eligibility are represented.** `failed` with `failed_at` and a coarse
-- `last_error_type` is terminal; `queued` with `p_retry_at` puts the row back with a future
-- `available_at`, which the claim's own predicate then respects. The schedule and the give-up point are
-- not here and are not the database's: they are the worker's published policy.
--
-- **The existing ownership model, untouched.** A notification's email is queued by 0029's writer,
-- deduplicated on the notification's own id, and linked back to the notification. 7-D reads what that
-- writer produced and writes nothing a notification can see.
--
-- Deterministic: fixed uuids, no wall-clock dependence beyond the deliberate availability fixtures.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(51);

insert into auth.users (id, email) values
  ('7d000000-0000-4000-8000-000000000001', 'relay-buyer@test.invalid'),
  ('7d000000-0000-4000-8000-000000000002', 'relay-quiet@test.invalid');

-- ---------------------------------------------------------------------------------------------------
-- Phase 7-D added no database object
-- ---------------------------------------------------------------------------------------------------
select has_table('public', 'email_outbox', 'the email outbox is 0008''s table, not a second one');
select has_function('app_private', 'claim_outbox_messages', array['text', 'integer'],
  'the claim is 0008''s function, with its signature unchanged');
select has_function('app_private', 'settle_outbox_message',
  array['text', 'uuid', 'text', 'text', 'text', 'timestamp with time zone'],
  'and so is the settle');
select has_function('app_private', 'attach_notification_email',
  array['uuid', 'text', 'text', 'text', 'text', 'text', 'text'],
  'the only writer of a notification''s email is still 0029''s');

select is(
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('claim_outbox_messages', 'settle_outbox_message')
      and p.prosecdef
      and p.proconfig @> array['search_path=pg_catalog, public']),
  2::bigint,
  'both are SECURITY DEFINER with a pinned search path'
);

select is(
  (select count(*) from pg_tables where schemaname = 'public' and tablename like '%email_outbox%'),
  1::bigint,
  'there is exactly one email outbox table in the database'
);

-- ---------------------------------------------------------------------------------------------------
-- The role boundary the worker's store depends on
-- ---------------------------------------------------------------------------------------------------
select ok(
  has_function_privilege('app_worker', 'app_private.claim_outbox_messages(text, integer)', 'execute'),
  'app_worker may claim'
);
select ok(
  has_function_privilege('app_worker', 'app_private.settle_outbox_message(text, uuid, text, text, text, timestamptz)', 'execute'),
  'and may settle'
);
select is(
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'email_outbox' and grantee = 'app_worker'),
  0::bigint,
  'and holds no privilege at all on the table itself, so the functions are the only way in'
);
select is(
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'email_outbox'
      and grantee in ('authenticated', 'anon', 'app_api')),
  0::bigint,
  'no browser-facing role can reach a queued email either'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.email_outbox'::regclass),
  'row level security is on'
);
select is(
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'email_outbox'),
  0::bigint,
  'with no policy, which is deny-by-default for everyone'
);

-- ---------------------------------------------------------------------------------------------------
-- Claiming: what identifies one attempt
-- ---------------------------------------------------------------------------------------------------
create temp table seeded as
select
  app_private.queue_email('first@example.test', 'First', '<p>1</p>', '1', '7d000000-0000-4000-8000-000000000001', 'order.placed', null, 'relay-1') as first_id,
  app_private.queue_email('second@example.test', 'Second', '<p>2</p>', '2', null, null, null, 'relay-2') as second_id,
  app_private.queue_email('later@example.test', 'Later', '<p>3</p>', '3', null, null, null, 'relay-3') as later_id;

select is(
  app_private.queue_email('first@example.test', 'First', '<p>1</p>', '1', null, null, null, 'relay-1'),
  null,
  'the dedupe key that already exists queues nothing, so a retried handler sends nothing twice'
);
select is((select count(*) from public.email_outbox), 3::bigint, 'three rows are queued');

-- The third is not yet available. Nothing else about it changes.
update public.email_outbox set available_at = now() + interval '1 hour'
 where id = (select later_id from seeded);

select is(
  (select count(*) from public.email_outbox where status = 'queued' and attempts = 0),
  3::bigint,
  'a queued email has made no attempt yet'
);

create temp table claimed as
select * from app_private.claim_outbox_messages('email', 50);

select is((select count(*) from claimed), 2::bigint,
  'a claim takes the available queued rows and leaves the one whose availability has not arrived');
select is(
  (select status from public.email_outbox where id = (select later_id from seeded)),
  'queued',
  'which is still queued'
);
select is(
  (select count(*) from public.email_outbox where status = 'sending' and attempts = 1),
  2::bigint,
  'each claimed row moved to sending and counted the attempt in the same statement'
);
select is(
  (select attempts from claimed where id = (select first_id from seeded)),
  1,
  'and the claim hands the worker that same counter, already including this attempt'
);
select is(
  (select destination from claimed where id = (select first_id from seeded)),
  'first@example.test',
  'the destination is the stored address'
);
select is(
  (select recipient_user_id from claimed where id = (select first_id from seeded)),
  '7d000000-0000-4000-8000-000000000001'::uuid,
  'and the row names the person it belongs to'
);
select is(
  (select array_agg(k order by k) from jsonb_object_keys(
     (select payload from claimed where id = (select first_id from seeded))) as k),
  array['body_html', 'body_text', 'locale_code', 'subject', 'template_key'],
  'the payload is exactly the five fields the relay parses'
);
select is(
  (select payload ->> 'subject' from claimed where id = (select first_id from seeded)),
  'First',
  'already rendered: the worker composes nothing'
);
select is(
  (select count(*) from app_private.claim_outbox_messages('email', 50)),
  0::bigint,
  'a second claim finds nothing, so no message is handed out twice'
);

select throws_ok(
  $$select * from app_private.claim_outbox_messages('email', 0)$$,
  'p_limit must be between 1 and 500',
  'a batch of nothing is refused'
);
select throws_ok(
  $$select * from app_private.claim_outbox_messages('email', 501)$$,
  'p_limit must be between 1 and 500',
  'and so is a batch larger than the function allows'
);
select throws_ok(
  $$select * from app_private.claim_outbox_messages('carrier-pigeon', 10)$$,
  'unknown notification channel carrier-pigeon',
  'and a channel that does not exist'
);

-- ---------------------------------------------------------------------------------------------------
-- Settling: success
-- ---------------------------------------------------------------------------------------------------
select ok(
  app_private.settle_outbox_message('email', (select first_id from seeded), 'sent', 'provider-message-1'),
  'a delivery settles as sent'
);
select is(
  (select format('%s/%s/%s/%s', status, provider_message_id,
            case when sent_at is null then 'no sent_at' else 'sent_at' end,
            case when failed_at is null then 'no failed_at' else 'failed_at' end)
     from public.email_outbox where id = (select first_id from seeded)),
  'sent/provider-message-1/sent_at/no failed_at',
  'recording the provider''s own id and the time, and nothing that looks like a failure'
);
select ok(
  not app_private.settle_outbox_message('email', (select first_id from seeded), 'failed', null, 'late_duplicate'),
  'settling it again lands on nothing, because only a message in sending can be settled'
);
select is(
  (select status from public.email_outbox where id = (select first_id from seeded)),
  'sent',
  'so a duplicate attempt cannot undo a delivery that already succeeded'
);

-- ---------------------------------------------------------------------------------------------------
-- Settling: retry eligibility
-- ---------------------------------------------------------------------------------------------------
select ok(
  app_private.settle_outbox_message('email', (select second_id from seeded), 'queued', null, 'provider_timeout',
    now() + interval '30 seconds'),
  'a transient failure returns the message to the queue'
);
select is(
  (select format('%s/%s/%s/%s', status, last_error_type,
            case when sent_at is null then 'no sent_at' else 'sent_at' end,
            case when failed_at is null then 'no failed_at' else 'failed_at' end)
     from public.email_outbox where id = (select second_id from seeded)),
  'queued/provider_timeout/no sent_at/no failed_at',
  'carrying the error class forward without claiming the message succeeded or gave up'
);
select ok(
  (select available_at > now() from public.email_outbox where id = (select second_id from seeded)),
  'and dated in the future, which is the whole of retry eligibility'
);
select is(
  (select count(*) from app_private.claim_outbox_messages('email', 50)),
  0::bigint,
  'so the next claim passes over it'
);
select is(
  (select attempts from public.email_outbox where id = (select second_id from seeded)),
  1,
  'and a requeue spends no attempt of its own: only a claim counts'
);

update public.email_outbox set available_at = now() - interval '1 second'
 where id = (select second_id from seeded);

create temp table reclaimed as
select * from app_private.claim_outbox_messages('email', 50);

select is((select count(*) from reclaimed where id = (select second_id from seeded)), 1::bigint,
  'once its time arrives it is claimed again');
select is(
  (select attempts from reclaimed where id = (select second_id from seeded)),
  2,
  'as the second attempt, counted by the claim'
);
select is(
  (select payload ->> 'subject' from reclaimed where id = (select second_id from seeded)),
  'Second',
  'with the message intact, which is why an email may be retried at all and a WhatsApp OTP may not'
);

-- ---------------------------------------------------------------------------------------------------
-- Settling: terminal failure
-- ---------------------------------------------------------------------------------------------------
select ok(
  app_private.settle_outbox_message('email', (select second_id from seeded), 'failed', null, 'provider_status_550'),
  'a message that has run out of attempts is failed'
);
select is(
  (select format('%s/%s/%s', status, last_error_type,
            case when failed_at is null then 'no failed_at' else 'failed_at' end)
     from public.email_outbox where id = (select second_id from seeded)),
  'failed/provider_status_550/failed_at',
  'which is how this schema says a message will not be delivered'
);
select is(
  (select count(*) from app_private.claim_outbox_messages('email', 50)),
  0::bigint,
  'and a failed message is never claimed again'
);

select throws_ok(
  $$select app_private.settle_outbox_message('email', '7d000000-0000-4000-8000-00000000000f', 'abandoned')$$,
  'unknown settlement status abandoned',
  'a settlement status the schema does not define is refused'
);

-- The constraint the worker sanitises error types against, proved rather than assumed.
select throws_ok(
  $$update public.email_outbox set last_error_type = '550 5.1.1 <bob@example.test>: rejected'
     where id = (select first_id from seeded)$$,
  '23514',
  null,
  'provider error text can never be stored: last_error_type is an error class name'
);
select is(
  (select obj_description('public.email_outbox'::regclass, 'pg_class') is not null
      or col_description('public.email_outbox'::regclass,
           (select attnum from pg_attribute where attrelid = 'public.email_outbox'::regclass and attname = 'last_error_type')) is not null),
  true,
  'and the column says so in the schema itself'
);

-- ---------------------------------------------------------------------------------------------------
-- The existing notification ownership model, untouched by 7-D
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  notification_id uuid;
begin
  notification_id := app_private.create_notification(
    '7d000000-0000-4000-8000-000000000001', 'orders', 'order.paid', 'orders.paid',
    '{}'::jsonb, null, null, null, null, false, 'system', null);
  perform app_private.attach_notification_email(
    notification_id, 'relay-buyer@test.invalid', 'Your order is paid', '<p>Paid</p>', 'Paid');
  perform app_private.attach_notification_email(
    notification_id, 'relay-buyer@test.invalid', 'Again', '<p>Again</p>', 'Again');
end;
$$;

select is(
  (select count(*) from public.email_outbox where dedupe_key like 'notification:%'),
  1::bigint,
  'a notification queues exactly one email however many times its handler runs'
);
select is(
  (select e.dedupe_key from public.email_outbox e
     join public.notifications n on n.email_outbox_id = e.id),
  format('notification:%s', (select id from public.notifications limit 1)),
  'keyed on the notification itself, which is where the deduplication lives'
);
select is(
  (select status from public.email_outbox e join public.notifications n on n.email_outbox_id = e.id),
  'queued',
  'and it arrives queued: delivery state belongs to the outbox, not to the notification'
);

update public.user_settings set notify_email = false
 where user_id = '7d000000-0000-4000-8000-000000000002';

do $$
declare
  quiet_id uuid;
begin
  quiet_id := app_private.create_notification(
    '7d000000-0000-4000-8000-000000000002', 'orders', 'order.paid', 'orders.paid');
  perform app_private.attach_notification_email(quiet_id, 'relay-quiet@test.invalid', 'S', '<p>B</p>', 'B');
end;
$$;

select is(
  (select count(*) from public.email_outbox where dedupe_key like 'notification:%'),
  1::bigint,
  'a person who turned email off is never queued one, so the relay can never deliver against their wish'
);

-- ---------------------------------------------------------------------------------------------------
-- There is no copy to resolve
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from public.email_templates),
  0::bigint,
  'email_templates holds no rows, so the worker resolves no template and invents no copy'
);
select is(
  (select count(*) from public.email_outbox where subject is null or body_html is null or body_text is null),
  0::bigint,
  'every queued email already carries its own rendered subject and bodies'
);

select finish();
rollback;
