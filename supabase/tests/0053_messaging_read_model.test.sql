-- pgTAP — migration 0053: the messaging read model (Phase 5-B).
--
-- Four readers, and most of this file is about what they refuse to say. A messaging reader that is
-- slightly too generous does not look wrong — an extra conversation in a list is just a conversation —
-- so the assertions are written from the other side: a stranger gets nothing, a stranger gets the *same*
-- nothing a missing conversation gets, a listing that was taken down carries no link and no price, and
-- a participant who left keeps their history and loses their inbox entry.
--
-- The other half is pagination. Both list readers page by position in a total order, and the properties
-- that matter are totality (every row appears on exactly one page), stability (the same page twice is
-- the same page) and non-overlap. The inbox's order has an undated tail — a conversation with no
-- messages sorts last — and a cursor has to be able to sit inside it, which is the edge this file
-- exercises hardest.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(130);

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
-- A is the buyer whose inbox is under test; B the seller they talk to; C a stranger; D a participant who
-- left; E a suspended seller; F the bulk user, who exists only to prove the limits.
insert into auth.users (id, email) values
  ('d0000000-0000-4000-8000-000000000001', 'buyer@test.invalid'),
  ('d0000000-0000-4000-8000-000000000002', 'seller@test.invalid'),
  ('d0000000-0000-4000-8000-000000000003', 'stranger@test.invalid'),
  ('d0000000-0000-4000-8000-000000000004', 'left@test.invalid'),
  ('d0000000-0000-4000-8000-000000000005', 'suspended-seller@test.invalid'),
  ('d0000000-0000-4000-8000-000000000006', 'bulk@test.invalid'),
  ('d0000000-0000-4000-8000-000000000007', 'bulk-counterpart@test.invalid');

insert into public.seller_profiles
  (user_id, slug, display_name, legal_name, contact_email, contact_phone_e164, country_code,
   status, suspended_at, verification_status, verified_at)
values
  ('d0000000-0000-4000-8000-000000000002', 'good-shop', 'Good Shop', 'Good Shop LLC',
   'good@test.invalid', '+201000000001', 'EG', 'active', null, 'verified', now() - interval '10 days'),
  ('d0000000-0000-4000-8000-000000000005', 'gone-shop', 'Gone Shop', 'Gone Shop LLC',
   'gone@test.invalid', '+201000000002', 'EG', 'suspended', now() - interval '1 day',
   'verified', now() - interval '10 days');

insert into public.categories (id, parent_id, slug, is_active, sort_order) values
  ('c1000000-0000-4000-8000-000000000001', null, 'furniture', true, 1);
insert into public.category_translations (category_id, locale_code, name) values
  ('c1000000-0000-4000-8000-000000000001', 'en', 'Furniture');

/** One listing in whatever state the case needs. */
create or replace function pg_temp.listing(
  p_id uuid, p_slug text, p_type text, p_status text, p_seller uuid, p_price bigint, p_title text
) returns void language plpgsql as $$
begin
  insert into public.listings (
    id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
    currency_code, price_minor, is_negotiable, status, country_code, city, created_at,
    approved_at, sold_at, archived_at, deleted_at
  ) values (
    p_id, p_seller, p_type, 'c1000000-0000-4000-8000-000000000001', p_slug,
    p_title, 'A description long enough to satisfy the length constraint.', 'en',
    'EGP', p_price, false, p_status, 'EG', 'Cairo', now() - interval '10 days',
    case when p_status in ('approved','active','sold','expired','archived') then now() - interval '9 days' else null end,
    case when p_status = 'sold' then now() - interval '1 day' else null end,
    case when p_status = 'archived' then now() - interval '1 day' else null end,
    case when p_status = 'deleted' then now() - interval '1 day' else null end
  );
end;
$$;

-- The N8 cases: one of every state the resolver has to decide.
select pg_temp.listing('11110000-0000-4000-8000-000000000001', 'walnut-table', 'product', 'active',
  'd0000000-0000-4000-8000-000000000002', 250000, 'Walnut dining table');
select pg_temp.listing('22220000-0000-4000-8000-000000000001', 'walnut-restoration', 'service', 'active',
  'd0000000-0000-4000-8000-000000000002', 150000, 'Walnut furniture restoration');
insert into public.listing_service_details
  (listing_id, pricing_model, delivery_days, revisions_included, requires_brief, scope)
values ('22220000-0000-4000-8000-000000000001', 'fixed', 14::smallint, 1::smallint, false,
        'Collection, restoration and return.');
select pg_temp.listing('11110000-0000-4000-8000-000000000002', 'sold-chair', 'product', 'sold',
  'd0000000-0000-4000-8000-000000000002', 90000, 'Sold oak chair');
select pg_temp.listing('11110000-0000-4000-8000-000000000003', 'expired-desk', 'product', 'expired',
  'd0000000-0000-4000-8000-000000000002', 70000, 'Expired pine desk');
select pg_temp.listing('11110000-0000-4000-8000-000000000004', 'archived-stool', 'product', 'archived',
  'd0000000-0000-4000-8000-000000000002', 30000, 'Archived elm stool');
select pg_temp.listing('11110000-0000-4000-8000-000000000005', 'draft-bench', 'product', 'draft',
  'd0000000-0000-4000-8000-000000000002', 40000, 'Draft teak bench');
select pg_temp.listing('11110000-0000-4000-8000-000000000006', 'rejected-lamp', 'product', 'rejected',
  'd0000000-0000-4000-8000-000000000002', 20000, 'Rejected brass lamp');
select pg_temp.listing('11110000-0000-4000-8000-000000000007', 'suspended-seller-shelf', 'product', 'active',
  'd0000000-0000-4000-8000-000000000005', 60000, 'Shelf of a suspended seller');

-- Conversations. Ids are chosen so the undated tail has a deterministic id order.
insert into public.conversations (id, subject_type, listing_id, listing_title_snapshot, created_by, closed_at)
values
  ('e0000000-0000-4000-8000-000000000001', 'listing', '11110000-0000-4000-8000-000000000001',
   'Walnut dining table', 'd0000000-0000-4000-8000-000000000001', null),
  ('e0000000-0000-4000-8000-000000000002', 'direct', null, null, 'd0000000-0000-4000-8000-000000000001', null),
  ('e0000000-0000-4000-8000-000000000003', 'direct', null, null, 'd0000000-0000-4000-8000-000000000001',
   now() - interval '30 minutes'),
  ('e0000000-0000-4000-8000-000000000004', 'direct', null, null, 'd0000000-0000-4000-8000-000000000001', null),
  ('e0000000-0000-4000-8000-000000000005', 'direct', null, null, 'd0000000-0000-4000-8000-000000000001', null),
  ('e0000000-0000-4000-8000-000000000006', 'direct', null, null, 'd0000000-0000-4000-8000-000000000001', null),
  ('e0000000-0000-4000-8000-000000000007', 'direct', null, null, 'd0000000-0000-4000-8000-000000000003', null);

insert into public.conversation_participants (conversation_id, user_id, role, is_muted) values
  ('e0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'buyer', false),
  ('e0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002', 'seller', false),
  ('e0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'buyer', true),
  ('e0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000002', 'seller', false),
  ('e0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000001', 'buyer', false),
  ('e0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000002', 'seller', false),
  ('e0000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000001', 'buyer', false),
  ('e0000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000002', 'seller', false),
  ('e0000000-0000-4000-8000-000000000005', 'd0000000-0000-4000-8000-000000000001', 'buyer', false),
  ('e0000000-0000-4000-8000-000000000005', 'd0000000-0000-4000-8000-000000000002', 'seller', false),
  ('e0000000-0000-4000-8000-000000000006', 'd0000000-0000-4000-8000-000000000001', 'buyer', false),
  ('e0000000-0000-4000-8000-000000000006', 'd0000000-0000-4000-8000-000000000002', 'seller', false),
  ('e0000000-0000-4000-8000-000000000007', 'd0000000-0000-4000-8000-000000000003', 'buyer', false),
  ('e0000000-0000-4000-8000-000000000007', 'd0000000-0000-4000-8000-000000000002', 'seller', false);

/** One message, with an explicit time so the ordering under test is the data's and not the clock's. */
create or replace function pg_temp.message(
  p_id uuid, p_conversation uuid, p_sender uuid, p_type text, p_body text,
  p_reference_type text, p_reference uuid, p_created timestamptz
) returns void language plpgsql as $$
begin
  insert into public.messages
    (id, conversation_id, sender_user_id, message_type, body, reference_type, reference_id, created_at)
  values (p_id, p_conversation, p_sender, p_type, p_body, p_reference_type, p_reference, p_created);
end;
$$;

-- Conversation 1: five messages, ending with a system message and carrying a listing reference.
select pg_temp.message('a1000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000002', 'text', 'Hello, it is still here.', null, null, now() - interval '50 minutes');
select pg_temp.message('a1000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000001', 'text', 'Good, I will take it.', null, null, now() - interval '40 minutes');
select pg_temp.message('a1000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000002', 'text', 'I can deliver on Tuesday.', null, null, now() - interval '30 minutes');
select pg_temp.message('a1000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000002', 'reference', null, 'listing',
  '11110000-0000-4000-8000-000000000001', now() - interval '20 minutes');
select pg_temp.message('a1000000-0000-4000-8000-000000000005', 'e0000000-0000-4000-8000-000000000001',
  null, 'system', 'The listing was updated.', null, null, now() - interval '10 minutes');

-- Conversation 2: muted by A, one message from each side.
select pg_temp.message('a2000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002',
  'd0000000-0000-4000-8000-000000000002', 'text', 'Are you still interested?', null, null, now() - interval '2 hours');
select pg_temp.message('a2000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000002',
  'd0000000-0000-4000-8000-000000000001', 'text', 'Yes, next week.', null, null, now() - interval '90 minutes');

-- Conversation 3: closed, one message, fully read.
select pg_temp.message('a3000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000003',
  'd0000000-0000-4000-8000-000000000002', 'text', 'Closing this one.', null, null, now() - interval '3 hours');

-- Conversation 4: two messages, then A leaves.
select pg_temp.message('a4000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000004',
  'd0000000-0000-4000-8000-000000000002', 'text', 'First message here.', null, null, now() - interval '4 hours');
select pg_temp.message('a4000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000004',
  'd0000000-0000-4000-8000-000000000002', 'text', 'Second message here.', null, null, now() - interval '3 hours 30 minutes');

-- Conversations 5 and 6 stay empty on purpose: they are the undated tail of the inbox order.

-- Conversation 7 belongs to the stranger and the seller; A is not in it.
select pg_temp.message('a7000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000007',
  'd0000000-0000-4000-8000-000000000002', 'text', 'Nothing to do with A.', null, null, now() - interval '5 hours');

-- A's read state: partly read in 1, unread in 2, fully read in 3.
update public.conversation_participants
   set last_read_seq = (select seq from public.messages where id = 'a1000000-0000-4000-8000-000000000002')
 where conversation_id = 'e0000000-0000-4000-8000-000000000001'
   and user_id = 'd0000000-0000-4000-8000-000000000001';

update public.conversation_participants
   set last_read_seq = (select seq from public.messages where id = 'a3000000-0000-4000-8000-000000000001')
 where conversation_id = 'e0000000-0000-4000-8000-000000000003'
   and user_id = 'd0000000-0000-4000-8000-000000000001';

-- A leaves conversation 4. Done last so the messages above are genuinely history. The time is `now()`
-- rather than something in the past because `conversation_participants_left_after_join` — 0014's own
-- rule — refuses a departure that precedes the arrival, and `joined_at` defaulted to this transaction.
update public.conversation_participants
   set left_at = now()
 where conversation_id = 'e0000000-0000-4000-8000-000000000004'
   and user_id = 'd0000000-0000-4000-8000-000000000001';

-- The bulk fixtures: 60 conversations for F, and one of them with 120 messages, so the default and the
-- maximum of each reader are measured rather than asserted from the source.
do $$
declare
  i integer;
  conversation_id uuid;
begin
  for i in 1..60 loop
    conversation_id := ('f0000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid;
    insert into public.conversations (id, subject_type, created_by)
    values (conversation_id, 'direct', 'd0000000-0000-4000-8000-000000000006');
    insert into public.conversation_participants (conversation_id, user_id, role)
    values (conversation_id, 'd0000000-0000-4000-8000-000000000006', 'buyer'),
           (conversation_id, 'd0000000-0000-4000-8000-000000000007', 'seller');
    insert into public.messages (conversation_id, sender_user_id, message_type, body, created_at)
    values (conversation_id, 'd0000000-0000-4000-8000-000000000007', 'text', 'Bulk message.',
            now() - (i || ' minutes')::interval);
  end loop;

  for i in 1..120 loop
    insert into public.messages (conversation_id, sender_user_id, message_type, body, created_at)
    values ('f0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000007', 'text',
            'Bulk message ' || i, now() - ((200 - i) || ' seconds')::interval);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- The inbox: who is in it
-- ---------------------------------------------------------------------------------------------------
select set_eq(
  $$select conversation_id::text from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)$$,
  $$values ('e0000000-0000-4000-8000-000000000001'), ('e0000000-0000-4000-8000-000000000002'),
           ('e0000000-0000-4000-8000-000000000003'), ('e0000000-0000-4000-8000-000000000005'),
           ('e0000000-0000-4000-8000-000000000006')$$,
  'a participant sees exactly their own current conversations'
);

select is(
  (select count(*)::int from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)
    where conversation_id = 'e0000000-0000-4000-8000-000000000007'),
  0,
  'and never a conversation they are not in'
);

select is(
  (select count(*)::int from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000004'::uuid)),
  0,
  'a user who is in no conversation has an empty inbox'
);

select is(
  (select count(*)::int from app_private.messaging_inbox('d0000000-0000-4000-8000-00000000ffff'::uuid)),
  0,
  'and so does a user id that names nobody — the same answer, so asking reveals nothing'
);

select is(
  (select count(*)::int from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)
    where conversation_id = 'e0000000-0000-4000-8000-000000000004'),
  0,
  'a conversation the caller has left is not in their active inbox'
);

select is(
  (select count(*)::int from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000002'::uuid)
    where conversation_id = 'e0000000-0000-4000-8000-000000000004'),
  1,
  'but it is still in the inbox of the participant who stayed'
);

select set_eq(
  $$select distinct membership_state from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)$$,
  $$values ('active')$$,
  'every row of an inbox is an active membership'
);

-- ---------------------------------------------------------------------------------------------------
-- The inbox: what each row says
-- ---------------------------------------------------------------------------------------------------
select set_eq(
  $$select jsonb_object_keys(to_jsonb(i))
      from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid) i limit 17$$,
  $$values ('conversation_id'), ('subject_type'), ('listing_id'), ('listing_title_snapshot'),
           ('membership_state'), ('is_muted'), ('is_closed'), ('closed_at'), ('unread_count'),
           ('last_message_id'), ('last_message_seq'), ('last_message_at'), ('last_message_type'),
           ('last_message_body'), ('last_message_sender_user_id'), ('last_message_deleted_at'),
           ('created_at')$$,
  'the inbox projection is exactly the approved set of columns'
);

select results_eq(
  $$select subject_type, listing_id::text, listing_title_snapshot
      from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)
     where conversation_id = 'e0000000-0000-4000-8000-000000000001'$$,
  $$values ('listing', '11110000-0000-4000-8000-000000000001', 'Walnut dining table')$$,
  'a listing conversation carries its subject type, listing id and title snapshot'
);

select results_eq(
  $$select subject_type, listing_id::text, listing_title_snapshot
      from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)
     where conversation_id = 'e0000000-0000-4000-8000-000000000002'$$,
  $$values ('direct', null::text, null::text)$$,
  'and a direct conversation carries none of them'
);

select is(
  (select is_muted from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)
    where conversation_id = 'e0000000-0000-4000-8000-000000000002'),
  true,
  'the caller''s own mute state is reported'
);

select is(
  (select is_muted from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000002'::uuid)
    where conversation_id = 'e0000000-0000-4000-8000-000000000002'),
  false,
  'and it is theirs alone: the other participant sees their own'
);

select is(
  (select is_closed from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)
    where conversation_id = 'e0000000-0000-4000-8000-000000000003'),
  true,
  'a closed conversation is still listed, and says that it is closed'
);

select isnt(
  (select closed_at from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)
    where conversation_id = 'e0000000-0000-4000-8000-000000000003'),
  null,
  'with the time it was closed'
);

select is(
  (select is_closed from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)
    where conversation_id = 'e0000000-0000-4000-8000-000000000001'),
  false,
  'an open conversation is not closed'
);

select results_eq(
  $$select last_message_id::text, last_message_type, last_message_body, last_message_sender_user_id::text
      from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)
     where conversation_id = 'e0000000-0000-4000-8000-000000000001'$$,
  $$values ('a1000000-0000-4000-8000-000000000005', 'system', 'The listing was updated.', null::text)$$,
  'the last-message summary is the newest message, system messages included'
);

select is(
  (select last_message_seq from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)
    where conversation_id = 'e0000000-0000-4000-8000-000000000001'),
  (select seq from public.messages where id = 'a1000000-0000-4000-8000-000000000005'),
  'and carries that message''s sequence, which is what a cursor is built from'
);

select is(
  (select last_message_at from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)
    where conversation_id = 'e0000000-0000-4000-8000-000000000001'),
  (select created_at from public.messages where id = 'a1000000-0000-4000-8000-000000000005'),
  'and its time'
);

select is(
  (select last_message_id from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)
    where conversation_id = 'e0000000-0000-4000-8000-000000000005'),
  null,
  'a conversation with no messages has no summary rather than a missing row'
);

select is(
  (select last_message_at from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)
    where conversation_id = 'e0000000-0000-4000-8000-000000000005'),
  null,
  'and no last message time'
);

-- ---------------------------------------------------------------------------------------------------
-- The inbox: unread counts
-- ---------------------------------------------------------------------------------------------------
select is(
  (select unread_count from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)
    where conversation_id = 'e0000000-0000-4000-8000-000000000001'),
  3::bigint,
  'unread counts every later message that is not the caller''s own'
);

select is(
  (select unread_count from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)
    where conversation_id = 'e0000000-0000-4000-8000-000000000002'),
  1::bigint,
  'a null last_read_seq means everything from the other side is unread, and nothing of the caller''s own'
);

select is(
  (select unread_count from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)
    where conversation_id = 'e0000000-0000-4000-8000-000000000003'),
  0::bigint,
  'a conversation read to its end has none'
);

select is(
  (select unread_count from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)
    where conversation_id = 'e0000000-0000-4000-8000-000000000005'),
  0::bigint,
  'and a conversation with no messages has none'
);

select is(
  (select unread_count from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000002'::uuid)
    where conversation_id = 'e0000000-0000-4000-8000-000000000001'),
  2::bigint,
  'the count is per caller: the seller''s own three messages are not unread to them'
);

select is(
  (select count(*)::int from app_private.messaging_conversation_messages(
     'd0000000-0000-4000-8000-000000000002'::uuid, 'e0000000-0000-4000-8000-000000000001'::uuid)
    where sender_user_id is null or sender_user_id <> 'd0000000-0000-4000-8000-000000000002'),
  2,
  'and that two is the buyer''s reply plus the system message, which nobody sent and everybody must read'
);

-- ---------------------------------------------------------------------------------------------------
-- The inbox: ordering
-- ---------------------------------------------------------------------------------------------------
select results_eq(
  $$select conversation_id::text from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)$$,
  $$values ('e0000000-0000-4000-8000-000000000001'), ('e0000000-0000-4000-8000-000000000002'),
           ('e0000000-0000-4000-8000-000000000003'), ('e0000000-0000-4000-8000-000000000006'),
           ('e0000000-0000-4000-8000-000000000005')$$,
  'the order is last_message_at desc nulls last, then id desc'
);

select ok(
  (select bool_and(previous >= current_value)
     from (select last_message_at as current_value,
                  lag(last_message_at) over (order by position) as previous
             from (select last_message_at, row_number() over () as position
                     from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)) numbered) ordered
    where previous is not null and current_value is not null),
  'dated rows are in descending order of activity'
);

select is(
  (select count(*)::int
     from (select last_message_at,
                  row_number() over () as position
             from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)) rows
    where last_message_at is null and position <= 3),
  0,
  'and every undated row sorts after every dated one'
);

-- ---------------------------------------------------------------------------------------------------
-- The inbox: cursor pagination
-- ---------------------------------------------------------------------------------------------------
select results_eq(
  $$select conversation_id::text
      from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid, 2)$$,
  $$values ('e0000000-0000-4000-8000-000000000001'), ('e0000000-0000-4000-8000-000000000002')$$,
  'the first page is the first two rows of that order'
);

select results_eq(
  $$select conversation_id::text
      from app_private.messaging_inbox(
        'd0000000-0000-4000-8000-000000000001'::uuid, 2,
        (select last_message_at from public.conversations where id = 'e0000000-0000-4000-8000-000000000002'),
        'e0000000-0000-4000-8000-000000000002'::uuid)$$,
  $$values ('e0000000-0000-4000-8000-000000000003'), ('e0000000-0000-4000-8000-000000000006')$$,
  'a dated cursor continues into the next two, crossing from the dated region into the tail'
);

select results_eq(
  $$select conversation_id::text
      from app_private.messaging_inbox(
        'd0000000-0000-4000-8000-000000000001'::uuid, 2, null,
        'e0000000-0000-4000-8000-000000000006'::uuid)$$,
  $$values ('e0000000-0000-4000-8000-000000000005')$$,
  'an undated cursor continues inside the tail, where only the id separates rows'
);

select is(
  (select count(*)::int from app_private.messaging_inbox(
     'd0000000-0000-4000-8000-000000000001'::uuid, 2, null, 'e0000000-0000-4000-8000-000000000005'::uuid)),
  0,
  'and the last cursor of the tail ends the traversal'
);

select set_eq(
  $$select conversation_id::text from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid, 2)
    union all
    select conversation_id::text from app_private.messaging_inbox(
      'd0000000-0000-4000-8000-000000000001'::uuid, 2,
      (select last_message_at from public.conversations where id = 'e0000000-0000-4000-8000-000000000002'),
      'e0000000-0000-4000-8000-000000000002'::uuid)
    union all
    select conversation_id::text from app_private.messaging_inbox(
      'd0000000-0000-4000-8000-000000000001'::uuid, 2, null, 'e0000000-0000-4000-8000-000000000006'::uuid)$$,
  $$select conversation_id::text from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)$$,
  'paging through covers every conversation exactly once — totality and no overlap'
);

select is(
  (select count(*)::int from (
     select conversation_id from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid, 2)
     intersect
     select conversation_id from app_private.messaging_inbox(
       'd0000000-0000-4000-8000-000000000001'::uuid, 2,
       (select last_message_at from public.conversations where id = 'e0000000-0000-4000-8000-000000000002'),
       'e0000000-0000-4000-8000-000000000002'::uuid)) shared),
  0,
  'adjacent pages share no row'
);

select results_eq(
  $$select conversation_id::text from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid, 2)$$,
  $$select conversation_id::text from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid, 2)$$,
  'the same page asked twice is the same page'
);

select is(
  (select count(*)::int from app_private.messaging_inbox(
     'd0000000-0000-4000-8000-000000000001'::uuid, 2,
     (select last_message_at from public.conversations where id = 'e0000000-0000-4000-8000-000000000001'),
     'e0000000-0000-4000-8000-000000000001'::uuid)
    where conversation_id = 'e0000000-0000-4000-8000-000000000001'),
  0,
  'a cursor never returns the row it points at'
);

-- ---------------------------------------------------------------------------------------------------
-- The inbox: limits
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000006'::uuid)),
  20,
  'the default page is 20 conversations'
);

select is(
  (select count(*)::int from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000006'::uuid, 50)),
  50,
  'the maximum page is 50'
);

select is(
  (select count(*)::int from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000006'::uuid, 999)),
  50,
  'and a larger request is clamped to it rather than honoured'
);

select is(
  (select count(*)::int from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000006'::uuid, 0)),
  1,
  'a limit of zero is clamped to one rather than returning an empty page'
);

-- ---------------------------------------------------------------------------------------------------
-- Messages: authorization
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from app_private.messaging_conversation_messages(
     'd0000000-0000-4000-8000-000000000001'::uuid, 'e0000000-0000-4000-8000-000000000001'::uuid)),
  5,
  'an active participant reads the conversation'
);

select is(
  (select count(*)::int from app_private.messaging_conversation_messages(
     'd0000000-0000-4000-8000-000000000001'::uuid, 'e0000000-0000-4000-8000-000000000004'::uuid)),
  2,
  'a participant who left still reads the history they were part of'
);

select is(
  (select count(*)::int from app_private.messaging_conversation_messages(
     'd0000000-0000-4000-8000-000000000003'::uuid, 'e0000000-0000-4000-8000-000000000001'::uuid)),
  0,
  'a stranger reads nothing'
);

select is(
  (select count(*)::int from app_private.messaging_conversation_messages(
     'd0000000-0000-4000-8000-000000000001'::uuid, 'e0000000-0000-4000-8000-00000000ffff'::uuid)),
  0,
  'and a conversation that does not exist returns the same nothing'
);

select is(
  (select count(*)::int from app_private.messaging_conversation_messages(
     'd0000000-0000-4000-8000-000000000001'::uuid, 'e0000000-0000-4000-8000-000000000007'::uuid)),
  0,
  'so being refused cannot be told apart from a conversation that is not there'
);

select is(
  (select count(*)::int from app_private.messaging_conversation_messages(
     'd0000000-0000-4000-8000-000000000001'::uuid, 'e0000000-0000-4000-8000-000000000003'::uuid)),
  1,
  'a closed conversation stays readable'
);

-- ---------------------------------------------------------------------------------------------------
-- Messages: projection
-- ---------------------------------------------------------------------------------------------------
select set_eq(
  $$select jsonb_object_keys(to_jsonb(m))
      from app_private.messaging_conversation_messages(
        'd0000000-0000-4000-8000-000000000001'::uuid, 'e0000000-0000-4000-8000-000000000001'::uuid) m
     limit 12$$,
  $$values ('id'), ('seq'), ('conversation_id'), ('sender_user_id'), ('is_own_message'),
           ('message_type'), ('body'), ('reference_type'), ('reference_id'), ('created_at'),
           ('edited_at'), ('deleted_at')$$,
  'the message projection is exactly the approved set of columns'
);

select is(
  (select count(*)::int
     from (select jsonb_object_keys(to_jsonb(m)) as key
             from app_private.messaging_conversation_messages(
               'd0000000-0000-4000-8000-000000000001'::uuid,
               'e0000000-0000-4000-8000-000000000001'::uuid) m limit 12) keys
    where key like '%attachment%'),
  0,
  'and introduces no attachment field: attachments are a later increment'
);

select results_eq(
  $$select message_type, body, reference_type, reference_id::text, is_own_message
      from app_private.messaging_conversation_messages(
        'd0000000-0000-4000-8000-000000000001'::uuid, 'e0000000-0000-4000-8000-000000000001'::uuid)
     where id = 'a1000000-0000-4000-8000-000000000002'$$,
  $$values ('text', 'Good, I will take it.', null::text, null::text, true)$$,
  'a text message projects its body, no reference, and is marked as the caller''s own'
);

select results_eq(
  $$select message_type, body, reference_type, reference_id::text, is_own_message
      from app_private.messaging_conversation_messages(
        'd0000000-0000-4000-8000-000000000001'::uuid, 'e0000000-0000-4000-8000-000000000001'::uuid)
     where id = 'a1000000-0000-4000-8000-000000000004'$$,
  $$values ('reference', null::text, 'listing', '11110000-0000-4000-8000-000000000001', false)$$,
  'a reference message projects its reference and no body'
);

select results_eq(
  $$select message_type, sender_user_id::text, is_own_message
      from app_private.messaging_conversation_messages(
        'd0000000-0000-4000-8000-000000000001'::uuid, 'e0000000-0000-4000-8000-000000000001'::uuid)
     where id = 'a1000000-0000-4000-8000-000000000005'$$,
  $$values ('system', null::text, false)$$,
  'a system message has no sender and is nobody''s own'
);

select is(
  (select is_own_message from app_private.messaging_conversation_messages(
     'd0000000-0000-4000-8000-000000000002'::uuid, 'e0000000-0000-4000-8000-000000000001'::uuid)
    where id = 'a1000000-0000-4000-8000-000000000002'),
  false,
  'and whose message it is depends on who is asking'
);

select is(
  (select deleted_at from app_private.messaging_conversation_messages(
     'd0000000-0000-4000-8000-000000000001'::uuid, 'e0000000-0000-4000-8000-000000000001'::uuid)
    where id = 'a1000000-0000-4000-8000-000000000001'),
  null,
  'deleted_at is reported as the schema holds it, with no masking invented here'
);

-- ---------------------------------------------------------------------------------------------------
-- Messages: ordering and cursor
-- ---------------------------------------------------------------------------------------------------
select results_eq(
  $$select id::text from app_private.messaging_conversation_messages(
      'd0000000-0000-4000-8000-000000000001'::uuid, 'e0000000-0000-4000-8000-000000000001'::uuid)$$,
  $$values ('a1000000-0000-4000-8000-000000000001'), ('a1000000-0000-4000-8000-000000000002'),
           ('a1000000-0000-4000-8000-000000000003'), ('a1000000-0000-4000-8000-000000000004'),
           ('a1000000-0000-4000-8000-000000000005')$$,
  'a page is returned oldest first, ready to render in reading order'
);

select ok(
  (select bool_and(seq > previous)
     from (select seq, lag(seq) over (order by position) as previous
             from (select seq, row_number() over () as position
                     from app_private.messaging_conversation_messages(
                       'd0000000-0000-4000-8000-000000000001'::uuid,
                       'e0000000-0000-4000-8000-000000000001'::uuid)) numbered) ordered
    where previous is not null),
  'and strictly ascending by seq'
);

select results_eq(
  $$select id::text from app_private.messaging_conversation_messages(
      'd0000000-0000-4000-8000-000000000001'::uuid, 'e0000000-0000-4000-8000-000000000001'::uuid, 2)$$,
  $$values ('a1000000-0000-4000-8000-000000000004'), ('a1000000-0000-4000-8000-000000000005')$$,
  'the first page is the newest messages, because a chat opens at its end'
);

select results_eq(
  $$select id::text from app_private.messaging_conversation_messages(
      'd0000000-0000-4000-8000-000000000001'::uuid, 'e0000000-0000-4000-8000-000000000001'::uuid, 2,
      (select seq from public.messages where id = 'a1000000-0000-4000-8000-000000000004'))$$,
  $$values ('a1000000-0000-4000-8000-000000000002'), ('a1000000-0000-4000-8000-000000000003')$$,
  'and the cursor pages backwards from there'
);

select results_eq(
  $$select id::text from app_private.messaging_conversation_messages(
      'd0000000-0000-4000-8000-000000000001'::uuid, 'e0000000-0000-4000-8000-000000000001'::uuid, 2,
      (select seq from public.messages where id = 'a1000000-0000-4000-8000-000000000002'))$$,
  $$values ('a1000000-0000-4000-8000-000000000001')$$,
  'until the conversation runs out'
);

select is(
  (select count(*)::int from app_private.messaging_conversation_messages(
     'd0000000-0000-4000-8000-000000000001'::uuid, 'e0000000-0000-4000-8000-000000000001'::uuid, 2,
     (select seq from public.messages where id = 'a1000000-0000-4000-8000-000000000001'))),
  0,
  'and then returns nothing'
);

select set_eq(
  $$select id::text from app_private.messaging_conversation_messages(
      'd0000000-0000-4000-8000-000000000001'::uuid, 'e0000000-0000-4000-8000-000000000001'::uuid, 2)
    union all
    select id::text from app_private.messaging_conversation_messages(
      'd0000000-0000-4000-8000-000000000001'::uuid, 'e0000000-0000-4000-8000-000000000001'::uuid, 2,
      (select seq from public.messages where id = 'a1000000-0000-4000-8000-000000000004'))
    union all
    select id::text from app_private.messaging_conversation_messages(
      'd0000000-0000-4000-8000-000000000001'::uuid, 'e0000000-0000-4000-8000-000000000001'::uuid, 2,
      (select seq from public.messages where id = 'a1000000-0000-4000-8000-000000000002'))$$,
  $$select id::text from app_private.messaging_conversation_messages(
      'd0000000-0000-4000-8000-000000000001'::uuid, 'e0000000-0000-4000-8000-000000000001'::uuid)$$,
  'paging through a conversation covers every message exactly once'
);

select is(
  (select count(*)::int from (
     select id from app_private.messaging_conversation_messages(
       'd0000000-0000-4000-8000-000000000001'::uuid, 'e0000000-0000-4000-8000-000000000001'::uuid, 2)
     intersect
     select id from app_private.messaging_conversation_messages(
       'd0000000-0000-4000-8000-000000000001'::uuid, 'e0000000-0000-4000-8000-000000000001'::uuid, 2,
       (select seq from public.messages where id = 'a1000000-0000-4000-8000-000000000004'))) shared),
  0,
  'adjacent message pages share no row'
);

select results_eq(
  $$select id::text from app_private.messaging_conversation_messages(
      'd0000000-0000-4000-8000-000000000001'::uuid, 'e0000000-0000-4000-8000-000000000001'::uuid, 2)$$,
  $$select id::text from app_private.messaging_conversation_messages(
      'd0000000-0000-4000-8000-000000000001'::uuid, 'e0000000-0000-4000-8000-000000000001'::uuid, 2)$$,
  'and the same page asked twice is the same page'
);

select is(
  (select count(*)::int from app_private.messaging_conversation_messages(
     'd0000000-0000-4000-8000-000000000006'::uuid, 'f0000000-0000-4000-8000-000000000001'::uuid)),
  50,
  'the default message page is 50'
);

select is(
  (select count(*)::int from app_private.messaging_conversation_messages(
     'd0000000-0000-4000-8000-000000000006'::uuid, 'f0000000-0000-4000-8000-000000000001'::uuid, 100)),
  100,
  'the maximum message page is 100'
);

select is(
  (select count(*)::int from app_private.messaging_conversation_messages(
     'd0000000-0000-4000-8000-000000000006'::uuid, 'f0000000-0000-4000-8000-000000000001'::uuid, 999)),
  100,
  'and a larger request is clamped to it'
);

select is(
  (select count(*)::int from app_private.messaging_conversation_messages(
     'd0000000-0000-4000-8000-000000000006'::uuid, 'f0000000-0000-4000-8000-000000000001'::uuid, 0)),
  1,
  'a limit of zero is clamped to one'
);

-- ---------------------------------------------------------------------------------------------------
-- The total unread count
-- ---------------------------------------------------------------------------------------------------
select is(
  app_private.messaging_unread_count('d0000000-0000-4000-8000-000000000001'::uuid),
  4::bigint,
  'the total is the sum of the counts the inbox shows'
);

select is(
  app_private.messaging_unread_count('d0000000-0000-4000-8000-000000000001'::uuid),
  (select coalesce(sum(unread_count), 0)::bigint
     from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid, 50)),
  'and it agrees with the inbox exactly, so a badge can always be cleared'
);

select is(
  (select count(*)::int from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)
    where conversation_id = 'e0000000-0000-4000-8000-000000000004'),
  0,
  'the conversation the caller left contributes nothing, because it is not in their inbox'
);

select is(
  app_private.messaging_unread_count('d0000000-0000-4000-8000-000000000003'::uuid),
  1::bigint,
  'a different user''s total is their own, over their own conversations'
);

select is(
  app_private.messaging_unread_count('d0000000-0000-4000-8000-00000000ffff'::uuid),
  0::bigint,
  'and a user id that names nobody has none'
);

select ok(
  (select is_muted from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)
    where conversation_id = 'e0000000-0000-4000-8000-000000000002')
  and app_private.messaging_unread_count('d0000000-0000-4000-8000-000000000001'::uuid) > 0,
  'muting does not zero the count: mute is a notification preference, not a read marker'
);

-- The boundary itself: moving the marker by exactly one message moves the count by exactly one.
update public.conversation_participants
   set last_read_seq = (select seq from public.messages where id = 'a1000000-0000-4000-8000-000000000003')
 where conversation_id = 'e0000000-0000-4000-8000-000000000001'
   and user_id = 'd0000000-0000-4000-8000-000000000001';

select is(
  (select unread_count from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)
    where conversation_id = 'e0000000-0000-4000-8000-000000000001'),
  2::bigint,
  'the marker is exclusive: the message it names is read, the ones after it are not'
);

update public.conversation_participants
   set last_read_seq = (select max(seq) from public.messages
                         where conversation_id = 'e0000000-0000-4000-8000-000000000001')
 where conversation_id = 'e0000000-0000-4000-8000-000000000001'
   and user_id = 'd0000000-0000-4000-8000-000000000001';

select is(
  (select unread_count from app_private.messaging_inbox('d0000000-0000-4000-8000-000000000001'::uuid)
    where conversation_id = 'e0000000-0000-4000-8000-000000000001'),
  0::bigint,
  'and reading to the end clears it'
);

select is(
  app_private.messaging_unread_count('d0000000-0000-4000-8000-000000000001'::uuid),
  1::bigint,
  'which leaves only the other conversation''s unread message in the total'
);

-- Restore the original marker so later assertions read the fixture they were written against.
update public.conversation_participants
   set last_read_seq = (select seq from public.messages where id = 'a1000000-0000-4000-8000-000000000002')
 where conversation_id = 'e0000000-0000-4000-8000-000000000001'
   and user_id = 'd0000000-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------------------------------------------
-- N8: the listing reference resolver
-- ---------------------------------------------------------------------------------------------------
select set_eq(
  $$select jsonb_object_keys(to_jsonb(r))
      from app_private.messaging_listing_reference('11110000-0000-4000-8000-000000000001'::uuid) r$$,
  $$values ('id'), ('status'), ('slug'), ('canonical_type'), ('title'), ('price_minor'),
           ('currency_code'), ('currency_minor_unit')$$,
  'the resolver projection is exactly the approved set of columns'
);

select results_eq(
  $$select id::text, status, slug, canonical_type, title, price_minor, currency_code, currency_minor_unit
      from app_private.messaging_listing_reference('11110000-0000-4000-8000-000000000001'::uuid)$$,
  $$values ('11110000-0000-4000-8000-000000000001', 'available', 'walnut-table', 'product',
            'Walnut dining table', 250000::bigint, 'EGP', 2::smallint)$$,
  'an available listing returns the compact public card'
);

select is(
  (select canonical_type from app_private.messaging_listing_reference('22220000-0000-4000-8000-000000000001'::uuid)),
  'service',
  'and a service says which surface owns its canonical URL'
);

/** Every unavailable state, asserted the same way. */
create or replace function pg_temp.unavailable(p_listing uuid, p_label text) returns setof text
language plpgsql as $$
declare
  row_found record;
begin
  select * into row_found from app_private.messaging_listing_reference(p_listing);
  return next is(row_found.status, 'no_longer_available', p_label || ' is reported as no longer available');
  return next is(row_found.id, p_listing, p_label || ' keeps its identity');
  return next is(row_found.slug, null, p_label || ' carries no slug, so no URL can be built from it');
  return next is(row_found.canonical_type, null, p_label || ' names no surface');
  return next is(row_found.price_minor, null, p_label || ' carries no price');
  return next is(row_found.currency_code, null, p_label || ' carries no currency');
end;
$$;

select pg_temp.unavailable('11110000-0000-4000-8000-000000000002'::uuid, 'a sold listing');
select pg_temp.unavailable('11110000-0000-4000-8000-000000000003'::uuid, 'an expired listing');
select pg_temp.unavailable('11110000-0000-4000-8000-000000000004'::uuid, 'an archived listing');
select pg_temp.unavailable('11110000-0000-4000-8000-000000000005'::uuid, 'a draft listing');
select pg_temp.unavailable('11110000-0000-4000-8000-000000000006'::uuid, 'a rejected listing');
select pg_temp.unavailable('11110000-0000-4000-8000-000000000007'::uuid, 'a suspended seller''s listing');

select is(
  (select title from app_private.messaging_listing_reference('11110000-0000-4000-8000-000000000002'::uuid)),
  'Sold oak chair',
  'a sold listing keeps its title, because that title has already been public'
);

select is(
  (select title from app_private.messaging_listing_reference('11110000-0000-4000-8000-000000000004'::uuid)),
  'Archived elm stool',
  'and so does an archived one'
);

select is(
  (select title from app_private.messaging_listing_reference('11110000-0000-4000-8000-000000000006'::uuid)),
  null,
  'a rejected listing withholds its title: the surface falls back to the conversation''s own snapshot'
);

select is(
  (select title from app_private.messaging_listing_reference('11110000-0000-4000-8000-000000000005'::uuid)),
  null,
  'and so does a draft, which never had a public title at all'
);

select is(
  (select title from app_private.messaging_listing_reference('11110000-0000-4000-8000-000000000007'::uuid)),
  null,
  'a suspended seller''s listing withholds it too, so suspension is not undone inside a chat'
);

select is(
  (select count(*)::int from app_private.messaging_listing_reference('11110000-0000-4000-8000-00000000ffff'::uuid)),
  0,
  'a listing id that names nothing resolves to no row'
);

select is(
  (select count(*)::int
     from (select jsonb_object_keys(to_jsonb(r)) as key
             from app_private.messaging_listing_reference('11110000-0000-4000-8000-000000000002'::uuid) r) keys
    where key in ('seller_user_id', 'seller', 'media', 'moderation_status', 'description',
                  'view_count', 'location', 'deleted_at', 'status_history')),
  0,
  'and no projection carries seller, media, moderation or other private listing detail'
);

-- ---------------------------------------------------------------------------------------------------
-- The security contract
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('messaging_inbox', 'messaging_conversation_messages',
                        'messaging_unread_count', 'messaging_listing_reference')
      and p.prosecdef),
  4,
  'all four readers are SECURITY DEFINER'
);

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('messaging_inbox', 'messaging_conversation_messages',
                        'messaging_unread_count', 'messaging_listing_reference')
      and p.proconfig = array['search_path=pg_catalog, public']),
  4,
  'and all four pin the same search_path'
);

select ok(
  has_function_privilege('app_system', 'app_private.messaging_inbox(uuid, integer, timestamptz, uuid)', 'execute')
  and has_function_privilege('app_system', 'app_private.messaging_conversation_messages(uuid, uuid, integer, bigint)', 'execute')
  and has_function_privilege('app_system', 'app_private.messaging_unread_count(uuid)', 'execute')
  and has_function_privilege('app_system', 'app_private.messaging_listing_reference(uuid)', 'execute'),
  'app_system may execute all four'
);

select ok(
  not has_function_privilege('authenticated', 'app_private.messaging_inbox(uuid, integer, timestamptz, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.messaging_conversation_messages(uuid, uuid, integer, bigint)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.messaging_unread_count(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.messaging_listing_reference(uuid)', 'execute'),
  'authenticated may execute none of them'
);

select ok(
  not has_function_privilege('anon', 'app_private.messaging_inbox(uuid, integer, timestamptz, uuid)', 'execute')
  and not has_function_privilege('anon', 'app_private.messaging_conversation_messages(uuid, uuid, integer, bigint)', 'execute')
  and not has_function_privilege('anon', 'app_private.messaging_unread_count(uuid)', 'execute')
  and not has_function_privilege('anon', 'app_private.messaging_listing_reference(uuid)', 'execute'),
  'and anon may execute none of them either'
);

select is(
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where n.nspname = 'app_private'
      and p.proname like 'messaging_%'
      and a.grantee = 0),
  0,
  'PUBLIC holds execute on none of them'
);

select set_eq(
  $$select relname || ':' || privilege_type
      from information_schema.role_table_grants g
      join pg_class c on c.relname = g.table_name
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
     where g.grantee = 'authenticated'
       and g.table_name in ('conversations', 'conversation_participants', 'messages', 'message_attachments')$$,
  $$values ('conversations:SELECT'), ('conversations:INSERT'), ('conversations:UPDATE'),
           ('conversation_participants:SELECT'), ('conversation_participants:UPDATE'),
           ('messages:SELECT'), ('messages:INSERT'), ('messages:UPDATE'),
           ('message_attachments:SELECT'), ('message_attachments:INSERT')$$,
  'the privileges authenticated holds on the messaging tables are exactly the ones 0014 granted'
);

select is(
  (select count(*)::int from public.security_contract_problems()),
  0,
  'and the whole security contract still holds after this migration'
);

select * from finish();
rollback;
