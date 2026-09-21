-- pgTAP — migration 0014: messaging, the membership version (UB6) and the Realtime topic policy (N3).
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(17);

insert into auth.users (id, email) values
  ('aaaaaaaa-1111-4111-8111-111111111111', 'a@example.test'),
  ('bbbbbbbb-2222-4222-8222-222222222222', 'b@example.test'),
  ('cccccccc-3333-4333-8333-333333333333', 'c@example.test');

insert into public.conversations (id, created_by)
values ('dddddddd-4444-4444-8444-444444444444', 'aaaaaaaa-1111-4111-8111-111111111111');

select is((select membership_version from public.conversations where id = 'dddddddd-4444-4444-8444-444444444444'), 1,
  'a new conversation starts at membership version 1');

-- UB6: every membership change bumps the version and writes an outbox event in the same transaction -----
insert into public.conversation_participants (conversation_id, user_id, role) values
  ('dddddddd-4444-4444-8444-444444444444', 'aaaaaaaa-1111-4111-8111-111111111111', 'buyer'),
  ('dddddddd-4444-4444-8444-444444444444', 'bbbbbbbb-2222-4222-8222-222222222222', 'seller');

select is((select membership_version from public.conversations where id = 'dddddddd-4444-4444-8444-444444444444'), 3,
  'each membership change increments the version');
select is(
  (select count(*) from public.outbox_events
    where event_type = 'conversation.membership_changed' and aggregate_id = 'dddddddd-4444-4444-8444-444444444444'),
  2::bigint,
  'and writes one outbox event per change, in the same transaction'
);

select is(
  public.conversation_topic('dddddddd-4444-4444-8444-444444444444'),
  'conversation:dddddddd-4444-4444-8444-444444444444:v3',
  'the topic name carries the current membership version'
);

-- Joining rules ------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-2222-4222-8222-222222222222","role":"authenticated","aal":"aal1"}', true);
create temp table participant_probe as
select public.can_join_realtime_topic('conversation:dddddddd-4444-4444-8444-444444444444:v3') as current_version,
       public.can_join_realtime_topic('conversation:dddddddd-4444-4444-8444-444444444444:v2') as old_version,
       public.can_join_realtime_topic('user:bbbbbbbb-2222-4222-8222-222222222222') as own_user_topic,
       public.can_join_realtime_topic('user:aaaaaaaa-1111-4111-8111-111111111111') as other_user_topic,
       public.can_join_realtime_topic('admin:dashboard') as unknown_topic,
       public.can_join_realtime_topic('conversation:not-a-uuid:v3') as malformed_topic;
reset role;

select ok((select current_version from participant_probe), 'a current participant may join the current topic');
select ok(not (select old_version from participant_probe), 'the previous version stops receiving messages (N3)');
select ok((select own_user_topic from participant_probe), 'a user may join their own notification topic');
select ok(not (select other_user_topic from participant_probe), 'but never somebody else''s');
select ok(not (select unknown_topic from participant_probe), 'an unknown topic shape is refused');
select ok(not (select malformed_topic from participant_probe), 'an unparsable topic is refused');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"cccccccc-3333-4333-8333-333333333333","role":"authenticated","aal":"aal1"}', true);
create temp table outsider_probe as
select public.can_join_realtime_topic('conversation:dddddddd-4444-4444-8444-444444444444:v3') as conversation_topic;
reset role;
select ok(not (select conversation_topic from outsider_probe), 'someone who is not a participant may not join');

-- Clients never publish ------------------------------------------------------------------------------------
select is(
  (select count(*) from pg_policy where polrelid = 'realtime.messages'::regclass and polcmd <> 'r'),
  0::bigint,
  'realtime.messages carries no insert policy: clients receive only'
);

-- Messages ---------------------------------------------------------------------------------------------------
insert into public.messages (id, conversation_id, sender_user_id, body)
values ('eeeeeeee-5555-4555-8555-555555555555', 'dddddddd-4444-4444-8444-444444444444',
        'aaaaaaaa-1111-4111-8111-111111111111', 'Hello there');

select is((select message_count from public.conversations where id = 'dddddddd-4444-4444-8444-444444444444'), 1,
  'a message updates the conversation counters');
select is(
  (select count(*) from public.outbox_events
    where event_type = 'conversation.message_created' and aggregate_id = 'dddddddd-4444-4444-8444-444444444444'),
  1::bigint,
  'and writes the outbox event the worker publishes from'
);
select isnt((select seq from public.messages where id = 'eeeeeeee-5555-4555-8555-555555555555'), null,
  'every message has a cursor for catch-up');

-- Blocking ------------------------------------------------------------------------------------------------------
insert into public.user_blocks (blocker_id, blocked_id)
values ('bbbbbbbb-2222-4222-8222-222222222222', 'aaaaaaaa-1111-4111-8111-111111111111');
select throws_ok(
  $$insert into public.messages (conversation_id, sender_user_id, body)
    values ('dddddddd-4444-4444-8444-444444444444', 'aaaaaaaa-1111-4111-8111-111111111111', 'Still there?')$$,
  '42501',
  null,
  'a blocked pair cannot keep talking'
);

-- Leaving the conversation bumps the version again, so the old topic dies -------------------------------------------
delete from public.user_blocks where blocker_id = 'bbbbbbbb-2222-4222-8222-222222222222';
update public.conversation_participants set left_at = now()
 where conversation_id = 'dddddddd-4444-4444-8444-444444444444' and user_id = 'bbbbbbbb-2222-4222-8222-222222222222';
select is((select membership_version from public.conversations where id = 'dddddddd-4444-4444-8444-444444444444'), 4,
  'a participant leaving increments the version too');

select * from finish();
rollback;
