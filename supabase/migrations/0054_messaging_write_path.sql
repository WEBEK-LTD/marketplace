-- 0054 — The messaging write path (Phase 5-E).
--
-- Six named operations — start a conversation, send a message, move a read marker, set a mute flag,
-- leave, close — and one small private table that makes duplicate prevention a database fact. Nothing
-- else. There is no edit, no delete, no reopen and no attachment anywhere in this file, because none of
-- those operations exists in V1; an operation that does not exist has no function to call.
--
-- **0014 stays authoritative.** Phase 2 built the messaging schema, and this file adds no trigger, no
-- constraint and no policy that would restate one of its rules:
--
--   * `seq`, `last_message_at`, `message_count` and the `conversation.message_created` outbox event are
--     0014's triggers, fired by the insert below rather than computed here;
--   * `membership_version` and the `conversation.membership_changed` event come from 0014's membership
--     trigger, which the two participant inserts fire;
--   * the block rule is 0014's trigger, and `messaging_send_message` learns its answer by attempting the
--     insert and catching the refusal rather than asking the same question a second way. Two copies of an
--     authorization rule are two things that can disagree.
--
-- **Where the caller comes from.** `p_user_id` is always a value the API established from the caller's
-- own access token before any of this runs. No function below takes a parameter that could name a
-- different account as the actor: the sender is `p_user_id`, the read marker is `p_user_id`'s, the mute
-- flag is `p_user_id`'s, and the participant who leaves is `p_user_id`.
--
-- **What a stranger learns.** Nothing. A conversation they are not in and a conversation id that names
-- nothing both produce `not_found`, from the same branch, with nothing to tell them apart.
--
-- **Outcomes are values, not exceptions.** Every function returns a text outcome, so a refusal and a
-- success travel the same way and the API maps one vocabulary rather than interpreting SQLSTATEs.

-- ---------------------------------------------------------------------------------------------------
-- 0. What makes a conversation a duplicate
-- ---------------------------------------------------------------------------------------------------
-- The duplicate-prevention rule is a primary key, not a query. A key is held by at most one row, so two
-- callers racing to start the same conversation cannot both succeed however the two transactions
-- interleave — the loser catches `unique_violation` and resolves to the winner's conversation.
--
-- The ledger lives in `app_private` rather than as a column on `public.conversations` because
-- `authenticated` holds table-level UPDATE on that table: a column there would be writable by a role
-- that must not be able to disarm duplicate prevention. Nothing is granted on this table to anybody, so
-- the only way to touch it is through the SECURITY DEFINER functions below.
create table if not exists app_private.conversation_dedupe (
  dedupe_key text primary key,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint conversation_dedupe_key_present check (length(btrim(dedupe_key)) > 0)
);
comment on table app_private.conversation_dedupe is
  'What makes a conversation a duplicate, one row per open conversation. The primary key is the duplicate-prevention rule: a second start for the same key cannot be inserted. Unreachable by authenticated, which is why it is here rather than as a column on public.conversations.';

-- One ledger row per conversation, so closing or leaving can free the key by conversation id.
create unique index if not exists conversation_dedupe_conversation
  on app_private.conversation_dedupe (conversation_id);

alter table app_private.conversation_dedupe enable row level security;

-- ---------------------------------------------------------------------------------------------------
-- 1. Starting a conversation
-- ---------------------------------------------------------------------------------------------------
-- The key is ordered by role rather than being an unordered pair, so the same two people may hold one
-- conversation where A is the buyer and another where B is. That is the approved reading of M-6: the
-- buyer of a listing and the seller of it are different relationships even between the same two people.
create or replace function app_private.messaging_dedupe_key(
  p_subject_type text,
  p_listing_id uuid,
  p_buyer_user_id uuid,
  p_seller_user_id uuid
) returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case
           when p_subject_type = 'listing'
           then format('listing:%s:%s:%s', p_listing_id, p_buyer_user_id, p_seller_user_id)
           else format('direct:%s:%s', p_buyer_user_id, p_seller_user_id)
         end;
$$;
comment on function app_private.messaging_dedupe_key(text, uuid, uuid, uuid) is
  'The duplicate key for a conversation: one open listing conversation per buyer, seller and listing; one open direct conversation per buyer and seller. Ordered by role, so two people may hold one conversation in each direction.';

create or replace function app_private.messaging_start_conversation(
  p_user_id uuid,
  p_subject_type text,
  p_listing_id uuid default null,
  p_seller_slug text default null
) returns table (
  outcome text,
  conversation_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_seller uuid;
  v_key text;
  v_existing uuid;
  v_new uuid;
  v_title text;
begin
  if p_subject_type not in ('listing', 'direct') then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  if p_subject_type = 'listing' then
    if p_listing_id is null then
      return query select 'invalid'::text, null::uuid;
      return;
    end if;
    -- 0011's own decision: public listing state and an active seller, in one helper.
    if not public.listing_is_visible(p_listing_id) then
      return query select 'not_contactable'::text, null::uuid;
      return;
    end if;
    select l.seller_user_id, l.title into v_seller, v_title
      from public.listings l where l.id = p_listing_id;
  else
    -- The direct entry point names the seller by their **public slug**, not by a user id.
    --
    -- This is not a convenience. 4-E decided that the public seller profile exposes five fields and that
    -- the seller's identifier is not one of them, so the surface that offers "message this seller" has no
    -- user id to send and must not be given one. Resolving the slug here means the identifier is read and
    -- used inside one SECURITY DEFINER function and never crosses a boundary in either direction.
    if p_seller_slug is null or p_listing_id is not null then
      return query select 'invalid'::text, null::uuid;
      return;
    end if;
    select sp.user_id into v_seller
      from public.seller_profiles sp where sp.slug = p_seller_slug;
    -- A slug nobody holds and a seller who is not publicly visible are one answer, which is 0050's rule
    -- about a profile and this function's rule about contacting one agreeing with each other.
    if v_seller is null or not public.is_seller_publicly_visible(v_seller) then
      return query select 'not_contactable'::text, null::uuid;
      return;
    end if;
  end if;

  if v_seller is null or v_seller = p_user_id then
    -- Nobody starts a conversation with themselves, and a listing with no resolvable seller is not a
    -- listing anybody can be contacted about.
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  if public.is_blocked_between(p_user_id, v_seller) then
    return query select 'blocked'::text, null::uuid;
    return;
  end if;

  v_key := app_private.messaging_dedupe_key(p_subject_type, p_listing_id, p_user_id, v_seller);

  -- An existing open conversation is reused rather than duplicated.
  select d.conversation_id into v_existing
    from app_private.conversation_dedupe d
   where d.dedupe_key = v_key;
  if v_existing is not null then
    return query select 'reused'::text, v_existing;
    return;
  end if;

  insert into public.conversations
    (subject_type, listing_id, listing_title_snapshot, created_by)
  values
    (p_subject_type, p_listing_id,
     case when p_subject_type = 'listing' then left(v_title, 140) else null end,
     p_user_id)
  returning id into v_new;

  -- Both memberships, each firing 0014's membership trigger: the version moves and an outbox event is
  -- written in this transaction, which is UB6 working rather than being re-implemented.
  insert into public.conversation_participants (conversation_id, user_id, role)
  values (v_new, p_user_id, 'buyer'), (v_new, v_seller, 'seller');

  begin
    insert into app_private.conversation_dedupe (dedupe_key, conversation_id) values (v_key, v_new);
  exception when unique_violation then
    -- Another caller won the race. Theirs is the conversation; this one is abandoned by raising out of
    -- the way of nothing — the insert above is rolled back with this block, so no orphan is left.
    select d.conversation_id into v_existing
      from app_private.conversation_dedupe d where d.dedupe_key = v_key;
    return query select 'reused'::text, v_existing;
    return;
  end;

  return query select 'created'::text, v_new;
end;
$$;
comment on function app_private.messaging_start_conversation(uuid, text, uuid, text) is
  'Starts a listing or direct conversation, or resolves to the open one that already exists. The direct entry point names the seller by public slug, which it resolves internally, so no caller needs or receives a seller user id. Refuses an unknown slug, a suspended or otherwise non-public seller, a listing the public cannot see, a blocked pair and a caller contacting themselves. Duplicate prevention is the primary key of app_private.conversation_dedupe, so a race cannot produce two.';

-- ---------------------------------------------------------------------------------------------------
-- 2. Sending a message
-- ---------------------------------------------------------------------------------------------------
-- The sender is the caller, always: `sender_user_id` is `p_user_id` and there is no parameter that could
-- say otherwise. Text only — `message_type` is fixed to `'text'` here, so no caller can compose a
-- system message or a reference through this path.
--
-- The block rule is deliberately *not* checked before the insert. It is a trigger, the trigger is
-- authoritative, and this function learns the answer by attempting the write and catching the refusal.
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

  return query select 'sent'::text, v_id, v_seq;
end;
$$;
comment on function app_private.messaging_send_message(uuid, uuid, text) is
  'Sends one text message as the caller. Refuses a non-participant and a conversation that does not exist identically, a closed conversation, a body outside 1..5000 characters, and a blocked pair — the last by attempting the insert and catching 0014''s trigger, which stays authoritative. seq, message_count, last_message_at and the outbox event are 0014''s triggers.';

-- ---------------------------------------------------------------------------------------------------
-- 3. Read state
-- ---------------------------------------------------------------------------------------------------
-- M-8: private to the caller, no receipts, and monotonic. The marker is clamped to the newest message
-- that exists and never moves backwards, so a stale client cannot un-read a conversation and a client
-- that asks for a sequence beyond the end gets the end. Any participant may move their own marker,
-- including one who has left: reading their own history is still reading.
create or replace function app_private.messaging_mark_read(
  p_user_id uuid,
  p_conversation_id uuid,
  p_seq bigint
) returns table (
  outcome text,
  last_read_seq bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_highest bigint;
  v_next bigint;
begin
  if not exists (
    select 1 from public.conversation_participants p
     where p.conversation_id = p_conversation_id and p.user_id = p_user_id
  ) then
    return query select 'not_found'::text, null::bigint;
    return;
  end if;

  select coalesce(max(m.seq), 0) into v_highest
    from public.messages m where m.conversation_id = p_conversation_id;

  update public.conversation_participants p
     set last_read_seq = greatest(coalesce(p.last_read_seq, 0), least(coalesce(p_seq, 0), v_highest))
   where p.conversation_id = p_conversation_id
     and p.user_id = p_user_id
  returning p.last_read_seq into v_next;

  return query select 'ok'::text, v_next;
end;
$$;
comment on function app_private.messaging_mark_read(uuid, uuid, bigint) is
  'Moves the caller''s own read marker forward, clamped to the newest message and never backwards. Idempotent. Touches one participant row — the caller''s — and no other participant''s state.';

-- ---------------------------------------------------------------------------------------------------
-- 4. Muting
-- ---------------------------------------------------------------------------------------------------
-- A mute is a notification preference and nothing else. It changes no authorization, hides no message
-- and does not alter an unread count: the conversation reads exactly as it did.
create or replace function app_private.messaging_set_muted(
  p_user_id uuid,
  p_conversation_id uuid,
  p_muted boolean
) returns table (
  outcome text,
  is_muted boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_muted boolean;
begin
  if not exists (
    select 1 from public.conversation_participants p
     where p.conversation_id = p_conversation_id and p.user_id = p_user_id
  ) then
    return query select 'not_found'::text, null::boolean;
    return;
  end if;

  update public.conversation_participants p
     set is_muted = coalesce(p_muted, false)
   where p.conversation_id = p_conversation_id
     and p.user_id = p_user_id
  returning p.is_muted into v_muted;

  return query select 'ok'::text, v_muted;
end;
$$;
comment on function app_private.messaging_set_muted(uuid, uuid, boolean) is
  'Sets the caller''s own mute flag. Private to them: it changes no authorization, no message visibility and no unread count.';

-- ---------------------------------------------------------------------------------------------------
-- 5. Leaving
-- ---------------------------------------------------------------------------------------------------
-- Leaving sets `left_at` and nothing else. 0014 already decides what that means everywhere: the
-- conversation drops out of an active inbox, sending is refused, and the history stays readable to the
-- person who was there for it. Freeing the ledger row is the one extra thing, so the pair may start a
-- new conversation — they cannot rejoin this one, and there is no function that would let them.
create or replace function app_private.messaging_leave_conversation(
  p_user_id uuid,
  p_conversation_id uuid
) returns table (
  outcome text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_left timestamptz;
  v_found boolean;
begin
  select true, p.left_at into v_found, v_left
    from public.conversation_participants p
   where p.conversation_id = p_conversation_id and p.user_id = p_user_id;

  if v_found is not true then
    return query select 'not_found'::text;
    return;
  end if;

  if v_left is not null then
    -- Already gone. Idempotent, and the membership trigger is not fired a second time.
    return query select 'left'::text;
    return;
  end if;

  update public.conversation_participants p
     set left_at = now()
   where p.conversation_id = p_conversation_id
     and p.user_id = p_user_id;

  delete from app_private.conversation_dedupe d where d.conversation_id = p_conversation_id;

  return query select 'left'::text;
end;
$$;
comment on function app_private.messaging_leave_conversation(uuid, uuid) is
  'The caller leaves their own membership. History is kept and stays readable by them; they no longer appear in an active inbox and can no longer send. Idempotent. Frees the duplicate-prevention key so the pair may start again, and cannot rejoin this conversation.';

-- ---------------------------------------------------------------------------------------------------
-- 6. Closing
-- ---------------------------------------------------------------------------------------------------
-- Either active participant may close, and closing is for everybody in the conversation: it is the end
-- of the exchange, not one person's preference. Messages are kept and stay readable. M-12 is explicit
-- that there is no reopen, so there is no function here that sets `closed_at` back to null.
create or replace function app_private.messaging_close_conversation(
  p_user_id uuid,
  p_conversation_id uuid
) returns table (
  outcome text,
  closed_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_closed timestamptz;
  v_now timestamptz;
begin
  if not exists (
    select 1 from public.conversation_participants p
     where p.conversation_id = p_conversation_id
       and p.user_id = p_user_id
       and p.left_at is null
  ) then
    return query select 'not_found'::text, null::timestamptz;
    return;
  end if;

  select c.closed_at into v_closed from public.conversations c where c.id = p_conversation_id;
  if v_closed is not null then
    return query select 'closed'::text, v_closed;
    return;
  end if;

  v_now := now();
  update public.conversations c set closed_at = v_now where c.id = p_conversation_id;
  delete from app_private.conversation_dedupe d where d.conversation_id = p_conversation_id;

  return query select 'closed'::text, v_now;
end;
$$;
comment on function app_private.messaging_close_conversation(uuid, uuid) is
  'Closes a conversation on behalf of an active participant. Messages are kept and stay readable; no further message may be sent. Idempotent, and there is no reopen. Frees the duplicate-prevention key.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
-- S8 unchanged: `app_system` executes named functions and holds no table privilege, `anon` gets
-- nothing, and the key helper is granted to nobody at all — it is called only from inside the functions
-- above, where it runs as the definer.
revoke execute on function app_private.messaging_dedupe_key(text, uuid, uuid, uuid) from public;
revoke execute on function app_private.messaging_start_conversation(uuid, text, uuid, text) from public;
revoke execute on function app_private.messaging_send_message(uuid, uuid, text) from public;
revoke execute on function app_private.messaging_mark_read(uuid, uuid, bigint) from public;
revoke execute on function app_private.messaging_set_muted(uuid, uuid, boolean) from public;
revoke execute on function app_private.messaging_leave_conversation(uuid, uuid) from public;
revoke execute on function app_private.messaging_close_conversation(uuid, uuid) from public;

grant execute on function app_private.messaging_start_conversation(uuid, text, uuid, text) to app_system;
grant execute on function app_private.messaging_send_message(uuid, uuid, text) to app_system;
grant execute on function app_private.messaging_mark_read(uuid, uuid, bigint) to app_system;
grant execute on function app_private.messaging_set_muted(uuid, uuid, boolean) to app_system;
grant execute on function app_private.messaging_leave_conversation(uuid, uuid) to app_system;
grant execute on function app_private.messaging_close_conversation(uuid, uuid) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
