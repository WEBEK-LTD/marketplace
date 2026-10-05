-- 0055 — Durable notifications for a sent message (Phase 5-G).
--
-- One new rule: a message that commits notifies the people who should hear about it, in the same
-- transaction as the message itself. Nothing else changes. There is no new table, no new outbox, no
-- second notification system, no worker queue, no email and no push — 0029 already owns all of that, and
-- this migration is a caller of it rather than a rival to it.
--
-- **Why it lives in the database.** The notification is part of the same atomic fact as the message: if
-- the message rolls back the notification must roll back with it, including the outbox event that
-- announces it. Creating it from request-layer code after the commit would give exactly the two failure
-- modes worth avoiding — a message nobody is told about, and a notification for a message that never
-- existed. Putting both inside `messaging_send_message` makes that impossible rather than unlikely.
--
-- **What is reused, not reimplemented.** `app_private.create_notification()` keeps every one of its
-- existing semantics, and this file relies on all of them:
--
--   * the user's own `notify_in_app` setting decides whether a row is produced at all, and a suppressed
--     notification returns null rather than raising — so a muted-by-settings recipient is silently
--     skipped and the send still succeeds;
--   * the dedupe key is honoured by 0029's own unique index and early return, so the same message and
--     recipient cannot produce two rows however often the path is retried;
--   * the `notification.created` outbox event is 0029's, emitted inside `create_notification`. Nothing
--     here emits a second one;
--   * the content is immutable once written, by 0029's trigger;
--   * the email copy stays 0029's business and is not attached here. 5-G is durable in-app rows only.
--
-- **Who is notified**, derived entirely from database participant state and never from anything a caller
-- said: every participant of the conversation who is *not* the sender, whose `left_at` is null, and
-- whose `is_muted` is false. The rule is written as a set, not as a pair, so it is already correct for a
-- conversation with a third member — support, say — the day one exists.
--
-- **What the notification carries.** A reference and a destination, and that is all. `subject_type` is
-- `message` and `subject_id` is the message's id; the variables hold the conversation id and nothing
-- else. No body, and by construction nothing that 0029's own `variables_carry_no_secret` constraint
-- would refuse: the message text is not metadata and has no business being copied into an inbox row.

-- ---------------------------------------------------------------------------------------------------
-- 1. The dedupe identity of one notification
-- ---------------------------------------------------------------------------------------------------
-- Message and recipient, and nothing else. 0029's dedupe index is global rather than per user, so the
-- recipient has to be part of the key — otherwise the first recipient's notification would suppress the
-- second one's. No body, no timestamp and nothing random: the same send always derives the same key,
-- which is what makes the whole path idempotent rather than merely usually-right.
create or replace function app_private.messaging_notification_dedupe_key(
  p_message_id uuid,
  p_recipient_user_id uuid
) returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select format('message:%s:%s', p_message_id, p_recipient_user_id);
$$;
comment on function app_private.messaging_notification_dedupe_key(uuid, uuid) is
  'The dedupe identity of a message notification: the message and the recipient. Global index, so the recipient belongs in the key; no body, no timestamp and nothing random, so the same send always derives the same key.';

-- ---------------------------------------------------------------------------------------------------
-- 2. Notifying a message's recipients
-- ---------------------------------------------------------------------------------------------------
-- Returns how many rows were actually created, which is not the same as how many participants were
-- eligible: a recipient who has turned in-app notifications off is eligible and produces nothing, and
-- `create_notification` says so by returning null. That is 0029's decision to make and this function
-- does not second-guess it.
--
-- No exception handler anywhere in here, and that is deliberate. A notification that cannot be written
-- is a failed send: the error propagates, the message insert rolls back with it, and the caller is told.
-- Swallowing it would commit a message that half the conversation never hears about.
create or replace function app_private.messaging_notify_message(
  p_conversation_id uuid,
  p_sender_user_id uuid,
  p_message_id uuid
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_recipient uuid;
  v_notification uuid;
  v_created integer := 0;
begin
  for v_recipient in
    select p.user_id
      from public.conversation_participants p
     where p.conversation_id = p_conversation_id
       and p.user_id <> p_sender_user_id
       and p.left_at is null
       and p.is_muted is not true
     -- Ordered so the same send always walks the same recipients in the same sequence.
     order by p.user_id
  loop
    v_notification := app_private.create_notification(
      v_recipient,
      'messages',
      'message.created',
      'messages.message_received',
      -- The minimum: where to look. Never the body, and never anything the recipient does not already
      -- have by being in this conversation.
      jsonb_build_object('conversation_id', p_conversation_id),
      'message',
      p_message_id,
      -- The existing authenticated messaging surface, as a relative path. No origin, no locale prefix
      -- and no builder: the unprefixed route is the canonical one and next-intl resolves the reader's
      -- language on arrival.
      format('/dashboard/messages/%s', p_conversation_id),
      app_private.messaging_notification_dedupe_key(p_message_id, v_recipient)
    );
    if v_notification is not null then
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end;
$$;
comment on function app_private.messaging_notify_message(uuid, uuid, uuid) is
  'Creates one durable notification per eligible recipient of a message: a current participant who is not the sender and is not muted. Recipients come from participant state, never from a caller. Suppression by the user''s own notify_in_app setting is 0029''s and is preserved, so the count returned can be lower than the number of eligible participants. Raises rather than swallowing, so a notification failure fails the send.';

-- ---------------------------------------------------------------------------------------------------
-- 3. Sending a message, now with its notifications
-- ---------------------------------------------------------------------------------------------------
-- Replaced rather than wrapped, because the notification has to be inside the same transaction and after
-- the insert that gives it a subject. Everything else about this function is unchanged from 0054: the
-- same participant check, the same closed check, the same 1..5000 body window, the same fixed
-- `message_type`, and the same deliberate absence of a block check — 0014's trigger is still the
-- authority and is still learned about by attempting the write and catching `insufficient_privilege`.
--
-- The notify call sits *outside* that exception block. Inside it, a failing notification would be caught
-- and reported as `blocked`, which would be both wrong and silent.
create or replace function app_private.messaging_send_message(
  p_user_id uuid,
  p_conversation_id uuid,
  p_body text
) returns table (
  outcome text,
  message_id uuid,
  seq bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_closed timestamptz;
  v_body text := btrim(coalesce(p_body, ''));
  v_id uuid;
  v_seq bigint;
begin
  -- Not an active participant is the same answer a conversation that does not exist gets.
  if not exists (
    select 1 from public.conversation_participants p
     where p.conversation_id = p_conversation_id
       and p.user_id = p_user_id
       and p.left_at is null
  ) then
    return query select 'not_found'::text, null::uuid, null::bigint;
    return;
  end if;

  select c.closed_at into v_closed from public.conversations c where c.id = p_conversation_id;
  if v_closed is not null then
    return query select 'closed'::text, null::uuid, null::bigint;
    return;
  end if;

  -- The same 1..5000 window `messages_text_has_body` enforces, applied first so the caller gets an
  -- outcome rather than a constraint violation. The constraint remains what makes it true.
  if length(v_body) < 1 or length(v_body) > 5000 then
    return query select 'invalid_body'::text, null::uuid, null::bigint;
    return;
  end if;

  begin
    insert into public.messages (conversation_id, sender_user_id, message_type, body)
    values (p_conversation_id, p_user_id, 'text', v_body)
    returning id, messages.seq into v_id, v_seq;
  exception when insufficient_privilege then
    -- 0014's block trigger raised. It is the authority on this; the insert is rolled back with the block.
    return query select 'blocked'::text, null::uuid, null::bigint;
    return;
  end;

  -- Phase 5-G. In this transaction, after the message exists, and not inside the block above: a
  -- notification that cannot be written takes the message with it rather than being reported as a
  -- different outcome. Zero eligible recipients is not a failure — it simply creates nothing.
  perform app_private.messaging_notify_message(p_conversation_id, p_user_id, v_id);

  return query select 'sent'::text, v_id, v_seq;
end;
$$;
comment on function app_private.messaging_send_message(uuid, uuid, text) is
  'Sends one text message as the caller, and creates the durable notifications for it in the same transaction. Refuses a non-participant and a conversation that does not exist identically, a closed conversation, a body outside 1..5000 characters, and a blocked pair — the last by attempting the insert and catching 0014''s trigger, which stays authoritative. seq, message_count, last_message_at and the message outbox event are 0014''s triggers; the notification rows and their outbox events are 0029''s.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
-- Unchanged: `app_system` executes the send and nothing else gains anything. The two new functions are
-- called only from inside a SECURITY DEFINER function, where they run as its owner, so neither is
-- granted to any role at all.
revoke execute on function app_private.messaging_notification_dedupe_key(uuid, uuid) from public;
revoke execute on function app_private.messaging_notify_message(uuid, uuid, uuid) from public;
revoke execute on function app_private.messaging_send_message(uuid, uuid, text) from public;

grant execute on function app_private.messaging_send_message(uuid, uuid, text) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
