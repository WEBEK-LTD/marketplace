-- pgTAP — migration 0055: the durable notification a sent message creates.
--
-- What is being held to account:
--
--   * the recipient set — every current, unmuted participant who is not the sender, for a conversation
--     with more than two members as much as for a pair;
--   * the shape of the row: category, subject, a relative action path, and variables that carry a
--     reference rather than the message;
--   * idempotency by a key derived from the message and the recipient, and nothing else;
--   * 0029's own suppression by the user's `notify_in_app` setting, preserved rather than bypassed;
--   * atomicity — a forced notification failure takes the message, its outbox event and the notification
--     outbox event down with it;
--   * the privilege model, unchanged.
--
-- Deterministic throughout: fixed uuids, no wall-clock dependence, and identity asserted as
-- (recipient, message, dedupe key) rather than as a generated notification id. `now()` is constant inside
-- a transaction, so message ids are captured as they are created rather than recovered by ordering.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(71);

-- Fixtures ------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('60000000-0000-4000-8000-000000000001', 'sender@test.invalid'),
  ('60000000-0000-4000-8000-000000000002', 'recipient@test.invalid'),
  ('60000000-0000-4000-8000-000000000003', 'third@test.invalid'),
  ('60000000-0000-4000-8000-000000000004', 'muted@test.invalid'),
  ('60000000-0000-4000-8000-000000000005', 'gone@test.invalid'),
  ('60000000-0000-4000-8000-000000000006', 'quiet@test.invalid'),
  ('60000000-0000-4000-8000-000000000007', 'stranger@test.invalid');

-- 0005 creates a user_settings row with every account, so this is an update. The quiet member has
-- in-app notifications switched off and must be skipped by 0029's own gate.
update public.user_settings set notify_in_app = false
 where user_id = '60000000-0000-4000-8000-000000000006';

-- A pair, and a conversation with six members — support and other roles make that possible, and the
-- rule has to be a set rather than a pair.
insert into public.conversations (id, subject_type, created_by) values
  ('ea000000-0000-4000-8000-000000000001', 'direct', '60000000-0000-4000-8000-000000000001'),
  ('ea000000-0000-4000-8000-000000000002', 'direct', '60000000-0000-4000-8000-000000000001');

insert into public.conversation_participants (conversation_id, user_id, role) values
  ('ea000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'buyer'),
  ('ea000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000002', 'seller'),
  ('ea000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000001', 'buyer'),
  ('ea000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000002', 'seller'),
  ('ea000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000003', 'member'),
  ('ea000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000004', 'member'),
  ('ea000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000005', 'member'),
  ('ea000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000006', 'member');

-- Muted before anything is sent, and one who has already left. `now()` rather than an interval: the
-- `left_after_join` constraint compares against `joined_at`, which is this same `now()`.
update public.conversation_participants set is_muted = true
 where conversation_id = 'ea000000-0000-4000-8000-000000000002'
   and user_id = '60000000-0000-4000-8000-000000000004';
update public.conversation_participants set left_at = now()
 where conversation_id = 'ea000000-0000-4000-8000-000000000002'
   and user_id = '60000000-0000-4000-8000-000000000005';

-- Message ids as they are created. Ordering by created_at would be meaningless: every row in this
-- transaction shares one `now()`.
create temporary table ids (name text primary key, id uuid not null);

-- ---------------------------------------------------------------------------------------------------
-- Basic creation
-- ---------------------------------------------------------------------------------------------------
insert into ids (name, id)
select 'm1', message_id from app_private.messaging_send_message(
  '60000000-0000-4000-8000-000000000001'::uuid,
  'ea000000-0000-4000-8000-000000000001'::uuid,
  'Still available?');

select isnt(
  (select id from ids where name = 'm1'),
  null,
  'a message sends, and the notification path does not get in its way'
);

select is(
  (select count(*)::int from public.notifications n
    where n.subject_type = 'message' and n.subject_id = (select id from ids where name = 'm1')),
  1,
  'and creates exactly one notification: one eligible recipient, one row'
);

select is(
  (select n.user_id from public.notifications n
    where n.subject_id = (select id from ids where name = 'm1')),
  '60000000-0000-4000-8000-000000000002'::uuid,
  'addressed to the other participant'
);

select is(
  (select count(*)::int from public.notifications n
    where n.subject_id = (select id from ids where name = 'm1')
      and n.user_id = '60000000-0000-4000-8000-000000000001'),
  0,
  'and never to the sender'
);

select is(
  (select n.category from public.notifications n
    where n.subject_id = (select id from ids where name = 'm1')),
  'messages',
  'the category is exactly messages'
);

select is(
  (select n.subject_type from public.notifications n
    where n.subject_id = (select id from ids where name = 'm1')),
  'message',
  'the subject type is exactly message'
);

select is(
  (select n.subject_id from public.notifications n
    where n.subject_id = (select id from ids where name = 'm1')),
  (select id from ids where name = 'm1'),
  'and the subject id is the message that was created'
);

select ok(
  (select n.action_path like '/%' and n.action_path not like '//%'
     from public.notifications n where n.subject_id = (select id from ids where name = 'm1')),
  'the action path is relative'
);

select is(
  (select n.action_path from public.notifications n
    where n.subject_id = (select id from ids where name = 'm1')),
  '/dashboard/messages/ea000000-0000-4000-8000-000000000001',
  'and identifies the conversation destination and nothing else'
);

select is(
  (select n.variables from public.notifications n
    where n.subject_id = (select id from ids where name = 'm1')),
  jsonb_build_object('conversation_id', 'ea000000-0000-4000-8000-000000000001'),
  'the variables carry a reference to where to look, and nothing else'
);

select ok(
  (select n.variables::text not like '%Still available%'
     from public.notifications n where n.subject_id = (select id from ids where name = 'm1')),
  'the message body is nowhere in them'
);

select is(
  (select n.event_type from public.notifications n
    where n.subject_id = (select id from ids where name = 'm1')),
  'message.created',
  'the event type names what happened'
);

select is(
  (select n.template_key from public.notifications n
    where n.subject_id = (select id from ids where name = 'm1')),
  'messages.message_received',
  'and the template key is the one this path uses'
);

select ok(
  (select n.origin = 'system' and n.actor_user_id is null and not n.is_marketing
     from public.notifications n where n.subject_id = (select id from ids where name = 'm1')),
  'it is a system notification, names no actor, and is not marketing'
);

select is(
  (select count(*)::int from public.outbox_events e
    where e.aggregate_type = 'notification' and e.event_type = 'notification.created'),
  1,
  '0029 published it through the outbox, once'
);

select is(
  (select count(*)::int from public.outbox_events e
    where e.aggregate_type = 'conversation' and e.event_type = 'conversation.message_created'),
  1,
  'and 0014''s own message event is still the only message event'
);

-- ---------------------------------------------------------------------------------------------------
-- Multiple participants
-- ---------------------------------------------------------------------------------------------------
insert into ids (name, id)
select 'm2', message_id from app_private.messaging_send_message(
  '60000000-0000-4000-8000-000000000001'::uuid,
  'ea000000-0000-4000-8000-000000000002'::uuid,
  'Message to a room.');

select set_eq(
  $$select n.user_id::text from public.notifications n
     where n.subject_id = (select id from ids where name = 'm2')$$,
  $$values ('60000000-0000-4000-8000-000000000002'), ('60000000-0000-4000-8000-000000000003')$$,
  'in a six-member conversation, exactly the two eligible members are notified'
);

select is(
  (select count(*)::int from public.notifications n
    where n.subject_id = (select id from ids where name = 'm2')
      and n.user_id = '60000000-0000-4000-8000-000000000001'),
  0,
  'the sender gets none of it'
);

select is(
  (select count(*)::int from public.notifications n
    where n.subject_id = (select id from ids where name = 'm2')
      and n.user_id = '60000000-0000-4000-8000-000000000005'),
  0,
  'a participant who has left gets none'
);

select is(
  (select count(*)::int from public.notifications n
    where n.subject_id = (select id from ids where name = 'm2')
      and n.user_id = '60000000-0000-4000-8000-000000000004'),
  0,
  'a muted participant gets none'
);

select is(
  (select count(*)::int from public.notifications n
    where n.subject_id = (select id from ids where name = 'm2')
      and n.user_id = '60000000-0000-4000-8000-000000000006'),
  0,
  'and the member who turned in-app notifications off gets none'
);

select is(
  (select count(*)::int from public.notifications n
    where n.subject_id = (select id from ids where name = 'm2')
      and n.user_id = '60000000-0000-4000-8000-000000000007'),
  0,
  'somebody who is not in the conversation at all is not a recipient'
);

select is(
  (select count(distinct n.user_id)::int from public.notifications n
    where n.subject_id = (select id from ids where name = 'm2')),
  2,
  'one row per recipient, never two for the same person'
);

-- ---------------------------------------------------------------------------------------------------
-- Muting, and what muting is not
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from app_private.messaging_conversation_messages(
     '60000000-0000-4000-8000-000000000004'::uuid,
     'ea000000-0000-4000-8000-000000000002'::uuid, 50, null)),
  1,
  'a muted participant still reads the message: muting is not hiding'
);

select ok(
  (select app_private.messaging_unread_count('60000000-0000-4000-8000-000000000004'::uuid)::bigint > 0),
  'and it still counts as unread for them'
);

-- Unmuted, then a later message: the same person is now eligible.
select is(
  (select outcome from app_private.messaging_set_muted(
     '60000000-0000-4000-8000-000000000004'::uuid,
     'ea000000-0000-4000-8000-000000000002'::uuid, false)),
  'ok',
  'the muted participant unmutes'
);

insert into ids (name, id)
select 'm3', message_id from app_private.messaging_send_message(
  '60000000-0000-4000-8000-000000000001'::uuid,
  'ea000000-0000-4000-8000-000000000002'::uuid,
  'A second message to the room.');

select is(
  (select count(*)::int from public.notifications n
    where n.subject_id = (select id from ids where name = 'm3')
      and n.user_id = '60000000-0000-4000-8000-000000000004'),
  1,
  'and is notified about the next message'
);

select is(
  (select count(*)::int from public.notifications n
    where n.subject_id = (select id from ids where name = 'm3')
      and n.user_id = '60000000-0000-4000-8000-000000000004'
      and n.subject_id <> (select id from ids where name = 'm2')),
  1,
  'about that message, not retroactively about the one they were muted for'
);

select is(
  (select count(*)::int from public.notifications n
    where n.subject_id = (select id from ids where name = 'm2')
      and n.user_id = '60000000-0000-4000-8000-000000000004'),
  0,
  'the earlier message stays unnotified: unmuting is not a backfill'
);

-- ---------------------------------------------------------------------------------------------------
-- Membership changes
-- ---------------------------------------------------------------------------------------------------
select is(
  (select membership_version from public.conversations
    where id = 'ea000000-0000-4000-8000-000000000002'),
  -- Six joins and one departure: 0014 counts a `left_at` change as a membership change too, which is
  -- exactly why the notifier reads participant state rather than trusting a cached idea of who is in.
  8,
  'the six memberships and the one departure moved the version through 0014''s own trigger'
);

select is(
  (select outcome from app_private.messaging_leave_conversation(
     '60000000-0000-4000-8000-000000000003'::uuid,
     'ea000000-0000-4000-8000-000000000002'::uuid)),
  'left',
  'a current participant leaves'
);

select is(
  (select membership_version from public.conversations
    where id = 'ea000000-0000-4000-8000-000000000002'),
  9,
  'which moves the membership version, exactly as it did before 5-G'
);

select ok(
  (select count(*)::int from public.outbox_events e
     where e.aggregate_type = 'conversation'
       and e.event_type = 'conversation.membership_changed') >= 7,
  'and writes its membership event, in this transaction'
);

insert into ids (name, id)
select 'm4', message_id from app_private.messaging_send_message(
  '60000000-0000-4000-8000-000000000001'::uuid,
  'ea000000-0000-4000-8000-000000000002'::uuid,
  'A message after somebody left.');

select is(
  (select count(*)::int from public.notifications n
    where n.subject_id = (select id from ids where name = 'm4')
      and n.user_id = '60000000-0000-4000-8000-000000000003'),
  0,
  'the participant who left before this message is not notified about it'
);

select set_eq(
  $$select n.user_id::text from public.notifications n
     where n.subject_id = (select id from ids where name = 'm4')$$,
  $$values ('60000000-0000-4000-8000-000000000002'), ('60000000-0000-4000-8000-000000000004')$$,
  'and the remaining eligible members are'
);

-- ---------------------------------------------------------------------------------------------------
-- Deduplication
-- ---------------------------------------------------------------------------------------------------
select is(
  (select n.dedupe_key from public.notifications n
    where n.subject_id = (select id from ids where name = 'm1')),
  'message:' || (select id from ids where name = 'm1') || ':60000000-0000-4000-8000-000000000002',
  'the dedupe key is the message and the recipient'
);

select is(
  app_private.messaging_notification_dedupe_key(
    (select id from ids where name = 'm1'), '60000000-0000-4000-8000-000000000002'::uuid),
  (select n.dedupe_key from public.notifications n
    where n.subject_id = (select id from ids where name = 'm1')),
  'derived by the function the write path uses, so the two can never disagree'
);

select isnt(
  app_private.messaging_notification_dedupe_key(
    (select id from ids where name = 'm2'), '60000000-0000-4000-8000-000000000002'::uuid),
  app_private.messaging_notification_dedupe_key(
    (select id from ids where name = 'm2'), '60000000-0000-4000-8000-000000000003'::uuid),
  'a different recipient is a different identity'
);

select isnt(
  app_private.messaging_notification_dedupe_key(
    (select id from ids where name = 'm1'), '60000000-0000-4000-8000-000000000002'::uuid),
  app_private.messaging_notification_dedupe_key(
    (select id from ids where name = 'm2'), '60000000-0000-4000-8000-000000000002'::uuid),
  'and a different message is a different identity'
);

select is(
  app_private.messaging_notification_dedupe_key(
    (select id from ids where name = 'm1'), '60000000-0000-4000-8000-000000000002'::uuid),
  app_private.messaging_notification_dedupe_key(
    (select id from ids where name = 'm1'), '60000000-0000-4000-8000-000000000002'::uuid),
  'the same message and recipient always derive the same key: nothing random, nothing timed'
);

-- Re-running the notifier is the retry a handler would perform. It must add nothing.
select is(
  app_private.messaging_notify_message(
    'ea000000-0000-4000-8000-000000000001'::uuid,
    '60000000-0000-4000-8000-000000000001'::uuid,
    (select id from ids where name = 'm1')),
  1,
  'notifying the same message again resolves to the row that already exists'
);

select is(
  (select count(*)::int from public.notifications n
    where n.subject_id = (select id from ids where name = 'm1')),
  1,
  'and creates no duplicate'
);

select lives_ok(
  $$select app_private.messaging_notify_message(
      'ea000000-0000-4000-8000-000000000001'::uuid,
      '60000000-0000-4000-8000-000000000001'::uuid,
      (select id from ids where name = 'm1')),
    app_private.messaging_notify_message(
      'ea000000-0000-4000-8000-000000000001'::uuid,
      '60000000-0000-4000-8000-000000000001'::uuid,
      (select id from ids where name = 'm1'))$$,
  'repeated invocation is idempotent rather than an error'
);

select is(
  (select count(*)::int from public.notifications n
    where n.subject_id = (select id from ids where name = 'm1')),
  1,
  'however many times it runs'
);

select is(
  (select count(*)::int from public.outbox_events e
    where e.aggregate_type = 'notification' and e.event_type = 'notification.created'),
  (select count(*)::int from public.notifications n where n.category = 'messages'),
  'one publication per notification, and no second event for a deduplicated one'
);

select ok(
  (select count(*)::int from public.notifications n
     where n.dedupe_key is null and n.category = 'messages') = 0,
  'every message notification carries a dedupe key: none is left unprotected'
);

-- ---------------------------------------------------------------------------------------------------
-- User settings
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from public.notifications n
    where n.user_id = '60000000-0000-4000-8000-000000000006'),
  0,
  'the member with notify_in_app off has no notification at all'
);

update public.user_settings set notify_in_app = true
 where user_id = '60000000-0000-4000-8000-000000000006';

insert into ids (name, id)
select 'm5', message_id from app_private.messaging_send_message(
  '60000000-0000-4000-8000-000000000001'::uuid,
  'ea000000-0000-4000-8000-000000000002'::uuid,
  'A message after they turned notifications back on.');

select is(
  (select count(*)::int from public.notifications n
    where n.subject_id = (select id from ids where name = 'm5')
      and n.user_id = '60000000-0000-4000-8000-000000000006'),
  1,
  'and is notified once the setting allows it — the gate is 0029''s, and it is not bypassed'
);

-- ---------------------------------------------------------------------------------------------------
-- Atomicity
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from public.messages m
    where m.id = (select id from ids where name = 'm1')),
  1,
  'the committed message and its notification are both here: they were written together'
);

create or replace function pg_temp.refuse_notification() returns trigger
language plpgsql
as $$
begin
  raise exception 'forced notification failure' using errcode = 'P0001';
end;
$$;

create trigger notifications_forced_failure before insert on public.notifications
  for each row execute function pg_temp.refuse_notification();

select throws_ok(
  $$select * from app_private.messaging_send_message(
      '60000000-0000-4000-8000-000000000001'::uuid,
      'ea000000-0000-4000-8000-000000000001'::uuid,
      'This one must not survive.')$$,
  'P0001',
  'forced notification failure',
  'a notification that cannot be written fails the send rather than being swallowed'
);

select is(
  (select count(*)::int from public.messages m
    where m.conversation_id = 'ea000000-0000-4000-8000-000000000001'
      and m.body = 'This one must not survive.'),
  0,
  'and the message rolls back with it'
);

select is(
  (select message_count from public.conversations
    where id = 'ea000000-0000-4000-8000-000000000001'),
  1,
  'the conversation''s counters roll back too — 0014''s trigger ran inside the same failed statement'
);

select is(
  (select count(*)::int from public.notifications n
    where n.variables ->> 'conversation_id' = 'ea000000-0000-4000-8000-000000000001'),
  1,
  'no notification row survives the rollback either'
);

select is(
  (select count(*)::int from public.outbox_events e
    where e.aggregate_type = 'conversation' and e.event_type = 'conversation.message_created'),
  5,
  'and neither does the message outbox event: five sends committed, the sixth left nothing'
);

select is(
  (select count(*)::int from public.outbox_events e
    where e.aggregate_type = 'notification' and e.event_type = 'notification.created'),
  (select count(*)::int from public.notifications n where n.category = 'messages'),
  'the notification outbox event rolls back with the notification it announces'
);

drop trigger notifications_forced_failure on public.notifications;

select lives_ok(
  $$select * from app_private.messaging_send_message(
      '60000000-0000-4000-8000-000000000001'::uuid,
      'ea000000-0000-4000-8000-000000000001'::uuid,
      'And sending works again.')$$,
  'with the failure removed, sending works again: nothing was left in a broken state'
);

-- ---------------------------------------------------------------------------------------------------
-- Privacy
-- ---------------------------------------------------------------------------------------------------
select ok(
  (select count(*)::int from public.notifications n
     where n.category = 'messages'
       and n.variables ?| array['body', 'message', 'text', 'code', 'otp', 'password', 'token',
                                'secret', 'access_token', 'refresh_token', 'device', 'credential']) = 0,
  'no message notification carries a body, a token, an OTP, a password, a secret, a device value or a credential'
);

select ok(
  (select count(*)::int from public.notifications n
     where n.category = 'messages'
       and (select count(*) from jsonb_object_keys(n.variables) k where k <> 'conversation_id') > 0) = 0,
  'the only variable key any of them has is conversation_id'
);

select ok(
  (select count(*)::int from public.notifications n
     where n.category = 'messages'
       and (n.action_path ~* '^[a-z]+:' or n.action_path like '//%' or n.action_path not like '/dashboard/messages/%')) = 0,
  'every action path is the relative messaging route: no scheme, no host, no protocol-relative form'
);

select ok(
  (select count(*)::int from public.notifications n
     join public.messages m on m.id = n.subject_id
     where n.category = 'messages' and n.user_id = m.sender_user_id) = 0,
  'no notification is ever addressed to the sender of its own message'
);

select ok(
  (select count(*)::int from public.notifications n
     join public.messages m on m.id = n.subject_id
     where n.category = 'messages'
       and not exists (
         select 1 from public.conversation_participants p
          where p.conversation_id = m.conversation_id and p.user_id = n.user_id
       )) = 0,
  'and every recipient is a participant of the conversation the message is in: no cross-user leakage'
);

select ok(
  (select count(*)::int from public.notifications n
     where n.category = 'messages' and n.actor_user_id is not null) = 0,
  'none of them names the sender as an actor either'
);

select is(
  (select pg_get_function_identity_arguments(p.oid)
     from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'app_private' and p.proname = 'messaging_send_message'),
  'p_user_id uuid, p_conversation_id uuid, p_body text',
  'the send takes a caller, a conversation and a body: there is no parameter a sender could name recipients with'
);

select is(
  (select count(*)::int from pg_proc p
     join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'app_private'
      and p.proname = 'messaging_notify_message'
      and pg_get_function_identity_arguments(p.oid) = 'p_conversation_id uuid, p_sender_user_id uuid, p_message_id uuid'),
  1,
  'and the notifier takes no recipient list: the set comes from participant state'
);

-- ---------------------------------------------------------------------------------------------------
-- The security contract
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from public.security_contract_problems()),
  0,
  '0055 leaves the security contract with nothing to report'
);

select ok(
  (select count(*)::int from pg_proc p
     join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'app_private'
      and p.proname in ('messaging_notify_message', 'messaging_send_message')
      and p.prosecdef
      and p.proconfig @> array['search_path=pg_catalog, public']) = 2,
  'both functions on the write path are SECURITY DEFINER with a pinned search_path'
);

select ok(
  not has_function_privilege('public', 'app_private.messaging_send_message(uuid, uuid, text)', 'execute')
  and not has_function_privilege('public', 'app_private.messaging_notify_message(uuid, uuid, uuid)', 'execute')
  and not has_function_privilege('public', 'app_private.messaging_notification_dedupe_key(uuid, uuid)', 'execute'),
  'PUBLIC may execute none of them'
);

select ok(
  not has_function_privilege('authenticated', 'app_private.messaging_send_message(uuid, uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.messaging_notify_message(uuid, uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.messaging_notification_dedupe_key(uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'app_private.messaging_send_message(uuid, uuid, text)', 'execute'),
  'and neither authenticated nor anon gained anything'
);

select ok(
  has_function_privilege('app_system', 'app_private.messaging_send_message(uuid, uuid, text)', 'execute'),
  'app_system may execute the send, which is the only application path in'
);

select ok(
  not has_function_privilege('app_system', 'app_private.messaging_notify_message(uuid, uuid, uuid)', 'execute')
  and not has_function_privilege('app_system', 'app_private.messaging_notification_dedupe_key(uuid, uuid)', 'execute'),
  'and cannot call the notifier directly: it runs only inside the send, as the definer'
);

select ok(
  not has_table_privilege('app_system', 'public.notifications', 'insert')
  and not has_table_privilege('authenticated', 'public.notifications', 'insert'),
  'nobody holds INSERT on notifications: creation is still 0029''s function and nothing else'
);

select finish();
rollback;
