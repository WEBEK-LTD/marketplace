-- pgTAP — migration 0054: the messaging write path (Phase 5-E).
--
-- A write path is where a permission mistake stops being a leak and becomes damage, so most of this file
-- is about refusal: a stranger cannot send, a caller cannot move somebody else's read marker, mute
-- somebody else, leave on their behalf or close with their identity, a blocked pair cannot talk, and a
-- suspended seller cannot be contacted at all.
--
-- The other half is that the rules 0014 already owns keep owning themselves. `seq`, `message_count`,
-- `last_message_at`, the outbox events and the block refusal are all asserted to happen *through* the
-- existing triggers rather than to have been re-implemented here — including the one that matters most:
-- the block rule is proved by attempting a real insert and watching the trigger stop it.
--
-- Duplicate prevention is asserted twice: once through the function, which resolves to the existing
-- conversation, and once against the database directly, because a rule that only the function enforces is
-- a rule a second caller can race past.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(103);

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
-- BUYER talks to SELLER. STRANGER is in nothing. BLOCKED has blocked BUYER. SUSPENDED is a suspended
-- seller. SECOND is a second buyer, for the pair-ordering case.
insert into auth.users (id, email) values
  ('50000000-0000-4000-8000-000000000001', 'buyer@test.invalid'),
  ('50000000-0000-4000-8000-000000000002', 'seller@test.invalid'),
  ('50000000-0000-4000-8000-000000000003', 'stranger@test.invalid'),
  ('50000000-0000-4000-8000-000000000004', 'blocked-seller@test.invalid'),
  ('50000000-0000-4000-8000-000000000005', 'suspended-seller@test.invalid'),
  ('50000000-0000-4000-8000-000000000006', 'second-buyer@test.invalid');

insert into public.seller_profiles
  (user_id, slug, display_name, legal_name, contact_email, contact_phone_e164, country_code,
   status, suspended_at, verification_status, verified_at)
values
  ('50000000-0000-4000-8000-000000000002', 'good-shop', 'Good Shop', 'Good Shop LLC',
   'good@test.invalid', '+201000000001', 'EG', 'active', null, 'verified', now() - interval '10 days'),
  ('50000000-0000-4000-8000-000000000004', 'blocked-shop', 'Blocked Shop', 'Blocked Shop LLC',
   'blocked@test.invalid', '+201000000004', 'EG', 'active', null, 'verified', now() - interval '10 days'),
  ('50000000-0000-4000-8000-000000000005', 'gone-shop', 'Gone Shop', 'Gone Shop LLC',
   'gone@test.invalid', '+201000000005', 'EG', 'suspended', now() - interval '1 day',
   'verified', now() - interval '10 days'),
  -- The buyer is also a seller, which is what makes the ordered-pair case testable.
  ('50000000-0000-4000-8000-000000000001', 'buyer-shop', 'Buyer Shop', 'Buyer Shop LLC',
   'buyershop@test.invalid', '+201000000009', 'EG', 'active', null, 'verified', now() - interval '10 days');

insert into public.categories (id, parent_id, slug, is_active, sort_order) values
  ('c1000000-0000-4000-8000-000000000001', null, 'furniture', true, 1);
insert into public.category_translations (category_id, locale_code, name) values
  ('c1000000-0000-4000-8000-000000000001', 'en', 'Furniture');

create or replace function pg_temp.listing(
  p_id uuid, p_slug text, p_status text, p_seller uuid, p_title text
) returns void language plpgsql as $$
begin
  insert into public.listings (
    id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
    currency_code, price_minor, is_negotiable, status, country_code, city, created_at,
    approved_at, sold_at, archived_at, deleted_at
  ) values (
    p_id, p_seller, 'product', 'c1000000-0000-4000-8000-000000000001', p_slug,
    p_title, 'A description long enough to satisfy the length constraint.', 'en',
    'EGP', 250000, false, p_status, 'EG', 'Cairo', now() - interval '10 days',
    case when p_status in ('approved','active','sold','expired','archived') then now() - interval '9 days' else null end,
    case when p_status = 'sold' then now() - interval '1 day' else null end,
    case when p_status = 'archived' then now() - interval '1 day' else null end,
    case when p_status = 'deleted' then now() - interval '1 day' else null end
  );
end;
$$;

select pg_temp.listing('11110000-0000-4000-8000-000000000001', 'walnut-table', 'active',
  '50000000-0000-4000-8000-000000000002', 'Walnut dining table');
select pg_temp.listing('11110000-0000-4000-8000-000000000002', 'draft-bench', 'draft',
  '50000000-0000-4000-8000-000000000002', 'Draft teak bench');
select pg_temp.listing('11110000-0000-4000-8000-000000000003', 'suspended-shelf', 'active',
  '50000000-0000-4000-8000-000000000005', 'Shelf of a suspended seller');
select pg_temp.listing('11110000-0000-4000-8000-000000000004', 'blocked-lamp', 'active',
  '50000000-0000-4000-8000-000000000004', 'Lamp of a blocking seller');
select pg_temp.listing('11110000-0000-4000-8000-000000000005', 'buyers-own-chair', 'active',
  '50000000-0000-4000-8000-000000000001', 'The buyer''s own chair');

-- The blocking seller has blocked the buyer.
insert into public.user_blocks (blocker_id, blocked_id, reason) values
  ('50000000-0000-4000-8000-000000000004', '50000000-0000-4000-8000-000000000001', 'test');

-- ---------------------------------------------------------------------------------------------------
-- Starting a conversation
-- ---------------------------------------------------------------------------------------------------
-- Conversation ids are captured here as they are created. Resolving them through the dedupe ledger
-- would break exactly where it matters: closing and leaving remove that row on purpose, and every row
-- created inside one transaction carries the same `now()`, so there is no ordering to fall back on.
create temporary table ids (name text primary key, id uuid not null);

create or replace function pg_temp.start_listing(p_caller uuid, p_listing uuid)
returns table (outcome text, conversation_id uuid) language sql as $$
  select * from app_private.messaging_start_conversation(p_caller, 'listing', p_listing, null);
$$;

-- The direct entry point takes the seller's public slug, because that is all the public seller profile
-- exposes. The helper keeps taking a user id so every assertion below still names the person it means,
-- and looks the slug up the way the profile page's visitor already has it.
create or replace function pg_temp.start_direct(p_caller uuid, p_seller uuid)
returns table (outcome text, conversation_id uuid) language sql as $$
  select * from app_private.messaging_start_conversation(
    p_caller, 'direct', null,
    (select sp.slug from public.seller_profiles sp where sp.user_id = p_seller));
$$;

select is(
  (select outcome from pg_temp.start_listing(
     '50000000-0000-4000-8000-000000000001'::uuid, '11110000-0000-4000-8000-000000000001'::uuid)),
  'created',
  'a listing conversation is created'
);

insert into ids (name, id)
select 'listing', conversation_id from app_private.conversation_dedupe where dedupe_key like 'listing:%';

select isnt(
  (select conversation_id from app_private.messaging_inbox('50000000-0000-4000-8000-000000000001'::uuid)),
  null,
  'and it appears in the buyer''s inbox'
);

select results_eq(
  $$select subject_type, listing_id::text, listing_title_snapshot
      from public.conversations
     where id = (select conversation_id from app_private.conversation_dedupe
                  where dedupe_key like 'listing:%')$$,
  $$values ('listing', '11110000-0000-4000-8000-000000000001', 'Walnut dining table')$$,
  'with subject_type listing, the listing id, and the title snapshotted'
);

select set_eq(
  $$select p.user_id::text || ':' || p.role
      from public.conversation_participants p
     where p.conversation_id = (select conversation_id from app_private.conversation_dedupe
                                 where dedupe_key like 'listing:%')$$,
  $$values ('50000000-0000-4000-8000-000000000001:buyer'), ('50000000-0000-4000-8000-000000000002:seller')$$,
  'and exactly two participants, the caller as buyer and the listing''s seller as seller'
);

select is(
  (select membership_version from public.conversations
    where id = (select conversation_id from app_private.conversation_dedupe where dedupe_key like 'listing:%')),
  3,
  'the membership version moved once per membership, through 0014''s own trigger'
);

select is(
  (select count(*)::int from public.outbox_events
    where aggregate_type = 'conversation' and event_type = 'conversation.membership_changed'),
  2,
  'and the membership-changed events were written in the same transaction'
);

-- Reuse -------------------------------------------------------------------------------------------
select results_eq(
  $$select outcome from pg_temp.start_listing(
      '50000000-0000-4000-8000-000000000001'::uuid, '11110000-0000-4000-8000-000000000001'::uuid)$$,
  $$values ('reused')$$,
  'starting the same listing conversation again reuses it'
);

select is(
  (select count(*)::int from public.conversations where listing_id = '11110000-0000-4000-8000-000000000001'),
  1,
  'and creates no duplicate'
);

select is(
  (select conversation_id from pg_temp.start_listing(
     '50000000-0000-4000-8000-000000000001'::uuid, '11110000-0000-4000-8000-000000000001'::uuid)),
  (select conversation_id from app_private.conversation_dedupe where dedupe_key like 'listing:%'),
  'reuse resolves to the conversation that already exists'
);

select is(
  (select outcome from pg_temp.start_direct(
     '50000000-0000-4000-8000-000000000001'::uuid, '50000000-0000-4000-8000-000000000002'::uuid)),
  'created',
  'a direct conversation with the same seller is a different conversation'
);

insert into ids (name, id)
select 'direct', conversation_id from app_private.conversation_dedupe
 where dedupe_key = 'direct:50000000-0000-4000-8000-000000000001:50000000-0000-4000-8000-000000000002';

select results_eq(
  $$select subject_type, listing_id::text, listing_title_snapshot
      from public.conversations where id = (select id from ids where name = 'direct')$$,
  $$values ('direct', null::text, null::text)$$,
  'with subject_type direct, no listing and no snapshot'
);

select is(
  (select outcome from pg_temp.start_direct(
     '50000000-0000-4000-8000-000000000001'::uuid, '50000000-0000-4000-8000-000000000002'::uuid)),
  'reused',
  'and starting it again reuses it'
);

select is(
  (select count(*)::int from public.conversations where subject_type = 'direct'),
  1,
  'creating no duplicate direct conversation'
);

-- The ordered pair: the same two people, the other way round, is its own conversation.
select is(
  (select outcome from pg_temp.start_direct(
     '50000000-0000-4000-8000-000000000002'::uuid, '50000000-0000-4000-8000-000000000001'::uuid)),
  'created',
  'the same two people in the opposite roles hold their own conversation'
);

insert into ids (name, id)
select 'reverse', conversation_id from app_private.conversation_dedupe
 where dedupe_key = 'direct:50000000-0000-4000-8000-000000000002:50000000-0000-4000-8000-000000000001';

select is(
  (select count(*)::int from public.conversations where subject_type = 'direct'),
  2,
  'so the key is ordered by role rather than being an unordered pair'
);

-- Refusals ----------------------------------------------------------------------------------------
select is(
  (select outcome from pg_temp.start_listing(
     '50000000-0000-4000-8000-000000000001'::uuid, '11110000-0000-4000-8000-000000000003'::uuid)),
  'not_contactable',
  'a suspended seller''s listing cannot be contacted about'
);

select is(
  (select outcome from pg_temp.start_direct(
     '50000000-0000-4000-8000-000000000001'::uuid, '50000000-0000-4000-8000-000000000005'::uuid)),
  'not_contactable',
  'and neither can the suspended seller directly'
);

select is(
  (select outcome from pg_temp.start_listing(
     '50000000-0000-4000-8000-000000000001'::uuid, '11110000-0000-4000-8000-000000000002'::uuid)),
  'not_contactable',
  'a listing the public cannot see cannot be contacted about either'
);

select is(
  (select outcome from pg_temp.start_listing(
     '50000000-0000-4000-8000-000000000001'::uuid, '11110000-0000-4000-8000-000000000004'::uuid)),
  'blocked',
  'a blocked pair cannot start a conversation'
);

select is(
  (select outcome from pg_temp.start_direct(
     '50000000-0000-4000-8000-000000000001'::uuid, '50000000-0000-4000-8000-000000000004'::uuid)),
  'blocked',
  'in either entry point'
);

select is(
  (select outcome from pg_temp.start_listing(
     '50000000-0000-4000-8000-000000000001'::uuid, '11110000-0000-4000-8000-000000000005'::uuid)),
  'invalid',
  'nobody starts a conversation with themselves'
);

select is(
  (select outcome from pg_temp.start_listing(
     '50000000-0000-4000-8000-000000000001'::uuid, '11110000-0000-4000-8000-0000000000ff'::uuid)),
  'not_contactable',
  'a listing that does not exist is not contactable'
);

select is(
  (select outcome from app_private.messaging_start_conversation(
     '50000000-0000-4000-8000-000000000001'::uuid, 'listing', null, null)),
  'invalid',
  'a listing entry with no listing is invalid'
);

select is(
  (select outcome from app_private.messaging_start_conversation(
     '50000000-0000-4000-8000-000000000001'::uuid, 'direct', '11110000-0000-4000-8000-000000000001'::uuid,
     'good-shop')),
  'invalid',
  'a direct entry that also names a listing is invalid'
);

select is(
  (select outcome from app_private.messaging_start_conversation(
     '50000000-0000-4000-8000-000000000001'::uuid, 'direct', null, null)),
  'invalid',
  'and a direct entry with no seller slug is invalid'
);

select is(
  (select outcome from app_private.messaging_start_conversation(
     '50000000-0000-4000-8000-000000000001'::uuid, 'direct', null, 'no-such-shop')),
  'not_contactable',
  'a slug nobody holds answers exactly as a seller who cannot be contacted does'
);

select is(
  (select outcome from app_private.messaging_start_conversation(
     '50000000-0000-4000-8000-000000000001'::uuid, 'service_request', null, 'good-shop')),
  'invalid',
  'a service_request conversation cannot be created: that domain does not exist yet'
);

select is(
  (select outcome from app_private.messaging_start_conversation(
     '50000000-0000-4000-8000-000000000001'::uuid, 'order', null, 'good-shop')),
  'invalid',
  'and neither can an order conversation'
);

-- Duplicate prevention is the database's, not the function's ---------------------------------------
select ok(
  (select indisunique
     from pg_index i join pg_class c on c.oid = i.indexrelid
    where c.relname = 'conversation_dedupe_pkey'),
  'the duplicate key is a unique index, so a race cannot produce two conversations'
);

select throws_ok(
  $$insert into app_private.conversation_dedupe (dedupe_key, conversation_id)
    values (
      (select dedupe_key from app_private.conversation_dedupe where dedupe_key like 'listing:%'),
      (select id from public.conversations where subject_type = 'direct' limit 1)
    )$$,
  '23505',
  null,
  'a second row for the same key is refused by the database itself'
);

select is(
  (select count(*)::int from information_schema.role_table_grants
    where table_schema = 'app_private' and table_name = 'conversation_dedupe'
      and grantee in ('authenticated', 'anon')),
  0,
  'and the ledger is unreachable by authenticated or anon'
);

-- ---------------------------------------------------------------------------------------------------
-- Sending
-- ---------------------------------------------------------------------------------------------------
create or replace function pg_temp.listing_conversation() returns uuid language sql stable as $$
  select id from ids where name = 'listing';
$$;

select is(
  (select outcome from app_private.messaging_send_message(
     '50000000-0000-4000-8000-000000000001'::uuid, pg_temp.listing_conversation(), 'Is it still available?')),
  'sent',
  'an active participant sends a message'
);

select is(
  (select sender_user_id from public.messages where body = 'Is it still available?'),
  '50000000-0000-4000-8000-000000000001'::uuid,
  'and the sender is the caller'
);

select is(
  (select message_type from public.messages where body = 'Is it still available?'),
  'text',
  'sent as a text message: no caller can compose a system or reference message here'
);

select isnt(
  (select seq from app_private.messaging_send_message(
     '50000000-0000-4000-8000-000000000002'::uuid, pg_temp.listing_conversation(), 'Yes, it is.')),
  null,
  'seq is assigned by 0014''s identity column'
);

select ok(
  (select max(m.seq) > min(m.seq) from public.messages m
    where m.conversation_id = pg_temp.listing_conversation()),
  'and increments between messages'
);

select is(
  (select message_count from public.conversations where id = pg_temp.listing_conversation()),
  2,
  'message_count was maintained by 0014''s trigger'
);

select is(
  (select last_message_at from public.conversations where id = pg_temp.listing_conversation()),
  (select max(created_at) from public.messages where conversation_id = pg_temp.listing_conversation()),
  'and so was last_message_at'
);

select is(
  (select count(*)::int from public.outbox_events
    where event_type = 'conversation.message_created'
      and (payload ->> 'conversation_id')::uuid = pg_temp.listing_conversation()),
  2,
  'and a message_created outbox event was written in the same transaction as each message'
);

select is(
  (select outcome from app_private.messaging_send_message(
     '50000000-0000-4000-8000-000000000003'::uuid, pg_temp.listing_conversation(), 'Let me in.')),
  'not_found',
  'a stranger cannot send, and learns nothing about the conversation'
);

select is(
  (select outcome from app_private.messaging_send_message(
     '50000000-0000-4000-8000-000000000001'::uuid, 'ffffffff-0000-4000-8000-000000000000'::uuid, 'Hello?')),
  'not_found',
  'and a conversation that does not exist gives the same answer'
);

select is(
  (select outcome from app_private.messaging_send_message(
     '50000000-0000-4000-8000-000000000001'::uuid, pg_temp.listing_conversation(), '   ')),
  'invalid_body',
  'a body of nothing but whitespace is refused'
);

select is(
  (select outcome from app_private.messaging_send_message(
     '50000000-0000-4000-8000-000000000001'::uuid, pg_temp.listing_conversation(), '')),
  'invalid_body',
  'and so is an empty one'
);

select is(
  (select outcome from app_private.messaging_send_message(
     '50000000-0000-4000-8000-000000000001'::uuid, pg_temp.listing_conversation(), repeat('x', 5001))),
  'invalid_body',
  'a body over five thousand characters is refused'
);

select is(
  (select outcome from app_private.messaging_send_message(
     '50000000-0000-4000-8000-000000000001'::uuid, pg_temp.listing_conversation(), repeat('x', 5000))),
  'sent',
  'and exactly five thousand is accepted'
);

select is(
  (select count(*)::int from public.messages
    where conversation_id = pg_temp.listing_conversation() and body = repeat('x', 5001)),
  0,
  'a refused body leaves no message behind'
);

-- The block rule, proved through the trigger ------------------------------------------------------
-- A conversation is built directly here so that a blocked pair can be *in* one: the start function
-- refuses to create it, which is the point, so the trigger needs its own setting to be tested in.
insert into public.conversations (id, subject_type, created_by)
values ('e9000000-0000-4000-8000-000000000001', 'direct', '50000000-0000-4000-8000-000000000001');
insert into public.conversation_participants (conversation_id, user_id, role) values
  ('e9000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'buyer'),
  ('e9000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000004', 'seller');

select is(
  (select outcome from app_private.messaging_send_message(
     '50000000-0000-4000-8000-000000000001'::uuid, 'e9000000-0000-4000-8000-000000000001'::uuid, 'Hello?')),
  'blocked',
  'a blocked pair cannot send: 0014''s trigger refuses it and the function reports that'
);

select is(
  (select count(*)::int from public.messages
    where conversation_id = 'e9000000-0000-4000-8000-000000000001'),
  0,
  'and the refused insert left nothing behind'
);

-- ---------------------------------------------------------------------------------------------------
-- Marking read
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.messaging_mark_read(
     '50000000-0000-4000-8000-000000000001'::uuid, pg_temp.listing_conversation(), 1::bigint)),
  'ok',
  'a participant marks read'
);

select is(
  (select last_read_seq from app_private.messaging_mark_read(
     '50000000-0000-4000-8000-000000000001'::uuid, pg_temp.listing_conversation(),
     (select max(seq) from public.messages where conversation_id = pg_temp.listing_conversation()))),
  (select max(seq) from public.messages where conversation_id = pg_temp.listing_conversation()),
  'and moving forward to the newest message reports that position'
);

select is(
  (select last_read_seq from app_private.messaging_mark_read(
     '50000000-0000-4000-8000-000000000001'::uuid, pg_temp.listing_conversation(), 1::bigint)),
  (select max(seq) from public.messages where conversation_id = pg_temp.listing_conversation()),
  'asking to move backwards changes nothing: the marker is monotonic'
);

select is(
  (select last_read_seq from app_private.messaging_mark_read(
     '50000000-0000-4000-8000-000000000001'::uuid, pg_temp.listing_conversation(), 999999::bigint)),
  (select max(seq) from public.messages where conversation_id = pg_temp.listing_conversation()),
  'and asking to move past the end clamps to the newest message'
);

select is(
  (select last_read_seq from app_private.messaging_mark_read(
     '50000000-0000-4000-8000-000000000001'::uuid, pg_temp.listing_conversation(), 999999::bigint)),
  (select last_read_seq from app_private.messaging_mark_read(
     '50000000-0000-4000-8000-000000000001'::uuid, pg_temp.listing_conversation(), 999999::bigint)),
  'repeating the same request is idempotent'
);

select is(
  (select unread_count from app_private.messaging_inbox('50000000-0000-4000-8000-000000000001'::uuid)
    where conversation_id = pg_temp.listing_conversation()),
  0::bigint,
  'reading to the end clears the caller''s unread count'
);

select ok(
  (select unread_count from app_private.messaging_inbox('50000000-0000-4000-8000-000000000002'::uuid)
    where conversation_id = pg_temp.listing_conversation()) > 0,
  'and leaves the other participant''s untouched'
);

select is(
  (select last_read_seq from public.conversation_participants
    where conversation_id = pg_temp.listing_conversation()
      and user_id = '50000000-0000-4000-8000-000000000002'),
  null,
  'the other participant''s marker was never written'
);

select is(
  (select outcome from app_private.messaging_mark_read(
     '50000000-0000-4000-8000-000000000003'::uuid, pg_temp.listing_conversation(), 1::bigint)),
  'not_found',
  'a stranger cannot mark anything read'
);

select is(
  (select count(*)::int from public.conversation_participants
    where conversation_id = pg_temp.listing_conversation()
      and user_id = '50000000-0000-4000-8000-000000000003'),
  0,
  'and their attempt created no membership'
);

-- ---------------------------------------------------------------------------------------------------
-- Muting
-- ---------------------------------------------------------------------------------------------------
select is(
  (select is_muted from app_private.messaging_set_muted(
     '50000000-0000-4000-8000-000000000001'::uuid, pg_temp.listing_conversation(), true)),
  true,
  'a participant mutes their own conversation'
);

select is(
  (select is_muted from public.conversation_participants
    where conversation_id = pg_temp.listing_conversation()
      and user_id = '50000000-0000-4000-8000-000000000002'),
  false,
  'and the other participant''s mute state is untouched'
);

select is(
  (select is_muted from app_private.messaging_set_muted(
     '50000000-0000-4000-8000-000000000001'::uuid, pg_temp.listing_conversation(), false)),
  false,
  'and they can unmute'
);

select is(
  (select outcome from app_private.messaging_set_muted(
     '50000000-0000-4000-8000-000000000003'::uuid, pg_temp.listing_conversation(), true)),
  'not_found',
  'a stranger cannot mute anything'
);

-- Mute changes nothing about unread ----------------------------------------------------------------
select is(
  (select outcome from app_private.messaging_set_muted(
     '50000000-0000-4000-8000-000000000002'::uuid, pg_temp.listing_conversation(), true)),
  'ok',
  'the seller mutes their own side'
);

select ok(
  (select unread_count from app_private.messaging_inbox('50000000-0000-4000-8000-000000000002'::uuid)
    where conversation_id = pg_temp.listing_conversation()) > 0,
  'and their unread count is unchanged: mute is a notification preference, not a read marker'
);

select is(
  (select count(*)::int from app_private.messaging_conversation_messages(
     '50000000-0000-4000-8000-000000000002'::uuid, pg_temp.listing_conversation())),
  3,
  'nor does muting change what they can read'
);

-- ---------------------------------------------------------------------------------------------------
-- Leaving
-- ---------------------------------------------------------------------------------------------------
-- The direct conversation the caller is about to leave, and the reverse-direction one they are not.
create or replace function pg_temp.direct_conversation() returns uuid language sql stable as $$
  select id from ids where name = 'reverse';
$$;

create or replace function pg_temp.left_conversation() returns uuid language sql stable as $$
  select id from ids where name = 'direct';
$$;

select is(
  (select outcome from app_private.messaging_send_message(
     '50000000-0000-4000-8000-000000000001'::uuid, pg_temp.left_conversation(), 'Before I go.')),
  'sent',
  'a message exists in the direct conversation before the caller leaves'
);

select is(
  (select outcome from app_private.messaging_leave_conversation(
     '50000000-0000-4000-8000-000000000001'::uuid, pg_temp.left_conversation())),
  'left',
  'the caller leaves their own membership'
);

select isnt(
  (select left_at from public.conversation_participants
    where conversation_id = pg_temp.left_conversation()
      and user_id = '50000000-0000-4000-8000-000000000001'),
  null,
  'left_at was set'
);

select is(
  (select left_at from public.conversation_participants
    where conversation_id = pg_temp.left_conversation()
      and user_id = '50000000-0000-4000-8000-000000000002'),
  null,
  'and the other participant was not touched'
);

select is(
  (select count(*)::int from app_private.messaging_inbox('50000000-0000-4000-8000-000000000001'::uuid)
    where conversation_id = pg_temp.left_conversation()),
  0,
  'the conversation is gone from their active inbox'
);

select is(
  (select count(*)::int from app_private.messaging_conversation_messages(
     '50000000-0000-4000-8000-000000000001'::uuid, pg_temp.left_conversation())),
  1,
  'but the history they were part of is still readable by them'
);

select is(
  (select outcome from app_private.messaging_send_message(
     '50000000-0000-4000-8000-000000000001'::uuid, pg_temp.left_conversation(), 'Let me back in.')),
  'not_found',
  'and they can no longer send'
);

select ok(
  (select membership_version from public.conversations where id = pg_temp.left_conversation()) > 3,
  'the membership version moved again, through 0014''s trigger'
);

select ok(
  (select count(*) from public.outbox_events
    where event_type = 'conversation.membership_changed'
      and (payload ->> 'conversation_id')::uuid = pg_temp.left_conversation()) >= 3,
  'and a membership-changed event was written in the same transaction as the departure'
);

select is(
  (select outcome from app_private.messaging_leave_conversation(
     '50000000-0000-4000-8000-000000000001'::uuid, pg_temp.left_conversation())),
  'left',
  'leaving twice is idempotent'
);

select is(
  (select outcome from app_private.messaging_leave_conversation(
     '50000000-0000-4000-8000-000000000003'::uuid, pg_temp.listing_conversation())),
  'not_found',
  'a stranger cannot leave a conversation they were never in'
);

select is(
  (select count(*)::int from public.conversation_participants
    where conversation_id = pg_temp.listing_conversation() and left_at is not null),
  0,
  'and nobody else was made to leave'
);

-- Leaving frees the pair to start again -------------------------------------------------------------
select is(
  (select outcome from pg_temp.start_direct(
     '50000000-0000-4000-8000-000000000001'::uuid, '50000000-0000-4000-8000-000000000002'::uuid)),
  'created',
  'after leaving, the pair may start a new conversation rather than being locked out forever'
);

select isnt(
  (select conversation_id from pg_temp.start_direct(
     '50000000-0000-4000-8000-000000000001'::uuid, '50000000-0000-4000-8000-000000000002'::uuid)),
  pg_temp.left_conversation(),
  'which is a new conversation, not the one they left'
);

-- ---------------------------------------------------------------------------------------------------
-- Closing
-- ---------------------------------------------------------------------------------------------------
select isnt(
  (select closed_at from app_private.messaging_close_conversation(
     '50000000-0000-4000-8000-000000000002'::uuid, pg_temp.listing_conversation())),
  null,
  'either active participant may close, seller included'
);

select isnt(
  (select closed_at from public.conversations where id = pg_temp.listing_conversation()),
  null,
  'and the conversation records when it was closed'
);

select is(
  (select outcome from app_private.messaging_send_message(
     '50000000-0000-4000-8000-000000000001'::uuid, pg_temp.listing_conversation(), 'One more thing.')),
  'closed',
  'no further message may be sent'
);

select is(
  (select count(*)::int from app_private.messaging_conversation_messages(
     '50000000-0000-4000-8000-000000000001'::uuid, pg_temp.listing_conversation())),
  3,
  'the history is kept and stays readable'
);

select is(
  (select message_count from public.conversations where id = pg_temp.listing_conversation()),
  3,
  'and nothing was deleted'
);

select is(
  (select closed_at from app_private.messaging_close_conversation(
     '50000000-0000-4000-8000-000000000001'::uuid, pg_temp.listing_conversation())),
  (select closed_at from public.conversations where id = pg_temp.listing_conversation()),
  'closing an already-closed conversation is idempotent and reports the original time'
);

select is(
  (select count(*)::int from app_private.conversation_dedupe
    where conversation_id = (select id from ids where name = 'listing')),
  0,
  'closing frees the duplicate-prevention key'
);

select is(
  (select outcome from pg_temp.start_listing(
     '50000000-0000-4000-8000-000000000001'::uuid, '11110000-0000-4000-8000-000000000001'::uuid)),
  'created',
  'so the pair may start a fresh conversation about the same listing'
);

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like '%reopen%'),
  0,
  'there is no reopen function anywhere'
);

select is(
  (select outcome from app_private.messaging_close_conversation(
     '50000000-0000-4000-8000-000000000003'::uuid, pg_temp.direct_conversation())),
  'not_found',
  'a stranger cannot close a conversation'
);

select is(
  (select closed_at from public.conversations where id = pg_temp.direct_conversation()),
  null,
  'and it stayed open'
);

select is(
  (select outcome from app_private.messaging_close_conversation(
     '50000000-0000-4000-8000-000000000001'::uuid, pg_temp.left_conversation())),
  'not_found',
  'a participant who has left cannot close either'
);

-- ---------------------------------------------------------------------------------------------------
-- Nothing was written that belongs to a later increment
-- ---------------------------------------------------------------------------------------------------
-- 5-G is that later increment: a successful send now creates durable notifications, so this is no
-- longer zero. What 0054's write path still owes is that it creates nothing *else* — every notification
-- in this scenario is a message notification pointing at a message in it.
select is(
  (select count(*)::int from public.notifications n
    where n.category <> 'messages' or n.subject_type <> 'message'),
  0,
  'the write path creates no notification other than the message notifications 5-G owns'
);

select is(
  (select count(*)::int from public.message_attachments),
  0,
  'and no attachment was created'
);

select is(
  (select count(*)::int from public.messages where message_type <> 'text'),
  0,
  'every message this path wrote is a text message'
);

-- ---------------------------------------------------------------------------------------------------
-- The security contract
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('messaging_start_conversation', 'messaging_send_message', 'messaging_mark_read',
                        'messaging_set_muted', 'messaging_leave_conversation', 'messaging_close_conversation')
      and p.prosecdef),
  6,
  'all six write functions are SECURITY DEFINER'
);

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('messaging_start_conversation', 'messaging_send_message', 'messaging_mark_read',
                        'messaging_set_muted', 'messaging_leave_conversation', 'messaging_close_conversation')
      and p.proconfig = array['search_path=pg_catalog, public']),
  6,
  'and all six pin the same search_path'
);

select ok(
  has_function_privilege('app_system', 'app_private.messaging_start_conversation(uuid, text, uuid, text)', 'execute')
  and has_function_privilege('app_system', 'app_private.messaging_send_message(uuid, uuid, text)', 'execute')
  and has_function_privilege('app_system', 'app_private.messaging_mark_read(uuid, uuid, bigint)', 'execute')
  and has_function_privilege('app_system', 'app_private.messaging_set_muted(uuid, uuid, boolean)', 'execute')
  and has_function_privilege('app_system', 'app_private.messaging_leave_conversation(uuid, uuid)', 'execute')
  and has_function_privilege('app_system', 'app_private.messaging_close_conversation(uuid, uuid)', 'execute'),
  'app_system may execute all six'
);

select ok(
  not has_function_privilege('authenticated', 'app_private.messaging_start_conversation(uuid, text, uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.messaging_send_message(uuid, uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.messaging_mark_read(uuid, uuid, bigint)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.messaging_set_muted(uuid, uuid, boolean)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.messaging_leave_conversation(uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.messaging_close_conversation(uuid, uuid)', 'execute'),
  'authenticated may execute none of them'
);

select ok(
  not has_function_privilege('anon', 'app_private.messaging_send_message(uuid, uuid, text)', 'execute')
  and not has_function_privilege('anon', 'app_private.messaging_start_conversation(uuid, text, uuid, text)', 'execute'),
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
  'PUBLIC holds execute on none of the messaging functions'
);

select ok(
  not has_function_privilege('app_system', 'app_private.messaging_dedupe_key(text, uuid, uuid, uuid)', 'execute'),
  'the key helper is internal: even app_system cannot call it directly'
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
  'authenticated gained no table privilege: the set is exactly what 0014 granted'
);

select is(
  (select count(*)::int from public.security_contract_problems()),
  0,
  'and the whole security contract still holds after this migration'
);

select * from finish();
rollback;
