-- 0053 — The messaging read model (Phase 5-B).
--
-- Four readers and nothing else. No table, no column, no trigger, no policy, no grant to `authenticated`,
-- and no write path of any kind: a conversation cannot be created, a message cannot be sent and a read
-- marker cannot be moved by anything in this file. 0014 built the messaging schema in Phase 2 and stays
-- exactly as it was.
--
-- **Where the caller comes from.** `p_user_id` is always a value the API established from the caller's
-- own access token, through the provider, before any of this runs (the Phase 5-A path). It is never a
-- value a browser supplied. That is why these functions take an id rather than reading a JWT claim:
-- under the approved architecture every authenticated operation runs as `app_system`, which is not
-- `authenticated` and carries no claims. Each function still enforces the caller's relationship to the
-- data it returns, so a mistake one layer up cannot turn into somebody else's inbox.
--
-- **Active membership and history are different questions**, and 0014 already answers both: a
-- participant row with `left_at` set is history. So:
--
--   * the inbox lists conversations where the caller is a *current* participant;
--   * the message reader admits anybody who has *ever* been a participant, because leaving a
--     conversation does not unsee what was said in it while they were there;
--   * neither grants any write capability, because neither writes.
--
-- **What a stranger learns.** Nothing. A conversation they are not in returns zero rows, which is the
-- same answer a conversation id that names nothing returns. There is no branch anywhere below that
-- distinguishes "not yours" from "does not exist".
--
-- **Ordering and cursors.** The two list readers page by a position in a total order, never by an
-- offset, so a page cannot repeat a row or skip one when the data moves underneath it. Each function
-- documents its own predicate, because the inbox's is the one with the interesting edge — a null
-- `last_message_at` sorts last, and a cursor has to be able to sit inside that tail.

-- ---------------------------------------------------------------------------------------------------
-- 1. The inbox
-- ---------------------------------------------------------------------------------------------------
-- Ordered `last_message_at desc nulls last, id desc`, which is the approved order and also the one
-- `conversations_recent` was built for.
--
-- The cursor is the pair (last_message_at, id) of the last row of the previous page, and the predicate
-- below is the "strictly after it in that order" test written out. It has two cases because the order
-- has two regions:
--
--   * a cursor with a timestamp is still in the dated region: a later row is either an older dated row,
--     or *any* undated row, because every undated row sorts after every dated one;
--   * a cursor without one is already inside the undated tail, where only `id desc` separates rows.
--
-- Both cases are strict, so the cursor row itself never comes back a second time, and together they
-- cover every row that follows — no page boundary can hide one.
create or replace function app_private.messaging_inbox(
  p_user_id uuid,
  p_limit integer default 20,
  p_cursor_last_message_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  conversation_id uuid,
  subject_type text,
  listing_id uuid,
  listing_title_snapshot text,
  membership_state text,
  is_muted boolean,
  is_closed boolean,
  closed_at timestamptz,
  unread_count bigint,
  last_message_id uuid,
  last_message_seq bigint,
  last_message_at timestamptz,
  last_message_type text,
  last_message_body text,
  last_message_sender_user_id uuid,
  last_message_deleted_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with bounded as (
    -- Default 20, maximum 50, and never zero: a page of nothing is a request the API rejects rather
    -- than a result this reader invents.
    select least(greatest(coalesce(p_limit, 20), 1), 50) as row_limit
  )
  select c.id,
         c.subject_type,
         c.listing_id,
         c.listing_title_snapshot,
         -- Always 'active' while the filter below stands. It is computed from `left_at` rather than
         -- written as a literal so the column keeps telling the truth if that ever changes.
         case when p.left_at is null then 'active' else 'left' end,
         p.is_muted,
         c.closed_at is not null,
         c.closed_at,
         -- Own messages are never unread. A message with no sender is a system message: it is not the
         -- caller's own, so it counts. `last_read_seq` null means nothing has been read yet.
         (select count(*)
            from public.messages m
           where m.conversation_id = c.id
             and m.sender_user_id is distinct from p_user_id
             and m.seq > coalesce(p.last_read_seq, 0)),
         last_message.id,
         last_message.seq,
         last_message.created_at,
         last_message.message_type,
         last_message.body,
         last_message.sender_user_id,
         last_message.deleted_at,
         c.created_at
    from public.conversations c
    join public.conversation_participants p
      on p.conversation_id = c.id
     and p.user_id = p_user_id
     -- Current membership only. A conversation the caller has left is still readable by id; it is not
     -- in their inbox, because the inbox is a list of conversations they are in.
     and p.left_at is null
   cross join bounded b
   -- The summary of the newest message, or nothing at all for a conversation that has none.
   left join lateral (
     select m.id, m.seq, m.created_at, m.message_type, m.body, m.sender_user_id, m.deleted_at
       from public.messages m
      where m.conversation_id = c.id
      order by m.seq desc
      limit 1
   ) last_message on true
   where (
     -- No cursor: the first page.
     (p_cursor_id is null)
     -- A dated cursor: older dated rows, then the whole undated tail.
     or (p_cursor_last_message_at is not null
         and ((c.last_message_at is not null
               and (c.last_message_at, c.id) < (p_cursor_last_message_at, p_cursor_id))
              or c.last_message_at is null))
     -- An undated cursor: already in the tail, where only the id separates rows.
     or (p_cursor_last_message_at is null
         and c.last_message_at is null
         and c.id < p_cursor_id)
   )
   order by c.last_message_at desc nulls last, c.id desc
   limit (select row_limit from bounded);
$$;

comment on function app_private.messaging_inbox(uuid, integer, timestamptz, uuid) is
  'One page of the caller''s inbox: conversations they are currently a participant of, newest activity first, with their own unread count, mute and membership state. A conversation they have left is not here; it remains readable by id through messaging_conversation_messages. Returns nothing for a user who is in no conversation.';

-- ---------------------------------------------------------------------------------------------------
-- 2. One conversation's messages
-- ---------------------------------------------------------------------------------------------------
-- Authorization is membership *ever*, not membership *now*: somebody who has left keeps their history.
-- A caller who was never a participant gets zero rows, and so does a conversation id that names nothing
-- — the same answer, so asking cannot confirm that a conversation exists.
--
-- The page is chosen newest-first and returned oldest-first. That is what a chat needs: it opens at the
-- bottom and pages backwards, so each request asks for the `p_limit` messages immediately before the
-- cursor, and the caller renders what comes back in reading order without re-sorting it. The next cursor
-- is the smallest `seq` in the page.
create or replace function app_private.messaging_conversation_messages(
  p_user_id uuid,
  p_conversation_id uuid,
  p_limit integer default 50,
  p_cursor_seq bigint default null
) returns table (
  id uuid,
  seq bigint,
  conversation_id uuid,
  sender_user_id uuid,
  is_own_message boolean,
  message_type text,
  body text,
  reference_type text,
  reference_id uuid,
  created_at timestamptz,
  edited_at timestamptz,
  deleted_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with allowed as (
    select exists (
      select 1
        from public.conversation_participants p
       where p.conversation_id = p_conversation_id
         and p.user_id = p_user_id
    ) as may_read
  ),
  bounded as (
    select least(greatest(coalesce(p_limit, 50), 1), 100) as row_limit
  ),
  page as (
    select m.id, m.seq, m.conversation_id, m.sender_user_id, m.message_type, m.body,
           m.reference_type, m.reference_id, m.created_at, m.edited_at, m.deleted_at
      from public.messages m
     cross join allowed a
     cross join bounded b
     where a.may_read
       and m.conversation_id = p_conversation_id
       -- Strictly before the cursor, in the same total order, so a page never repeats a message.
       and (p_cursor_seq is null or m.seq < p_cursor_seq)
     order by m.seq desc
     limit (select row_limit from bounded)
  )
  select page.id,
         page.seq,
         page.conversation_id,
         page.sender_user_id,
         -- Saves every caller from re-deriving it, and keeps "whose message is this" one answer.
         page.sender_user_id is not distinct from p_user_id,
         page.message_type,
         page.body,
         page.reference_type,
         page.reference_id,
         page.created_at,
         page.edited_at,
         -- Reported, never acted on. 0014 records that a message was deleted; what a surface does with
         -- that is a decision this reader does not own and does not pre-empt by masking anything.
         page.deleted_at
    from page
   order by page.seq asc;
$$;

comment on function app_private.messaging_conversation_messages(uuid, uuid, integer, bigint) is
  'One page of a conversation''s messages for a caller who is or once was a participant, chosen newest-first from the cursor and returned oldest-first for rendering. A stranger and a conversation that does not exist both return no rows. Attachments are deliberately absent: they are a later increment.';

-- ---------------------------------------------------------------------------------------------------
-- 3. The caller's total unread count
-- ---------------------------------------------------------------------------------------------------
-- The same rule as the per-conversation count, summed over the same set of conversations the inbox
-- lists — current memberships. That is deliberate: a badge that counted conversations the inbox does
-- not show would be a number nobody could ever clear.
--
-- Mute is not consulted. Muting is a notification preference; it says nothing about whether a message
-- has been read, and a muted conversation with unread messages has unread messages.
create or replace function app_private.messaging_unread_count(p_user_id uuid) returns bigint
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(sum(
    (select count(*)
       from public.messages m
      where m.conversation_id = p.conversation_id
        and m.sender_user_id is distinct from p_user_id
        and m.seq > coalesce(p.last_read_seq, 0))
  ), 0)::bigint
    from public.conversation_participants p
   where p.user_id = p_user_id
     and p.left_at is null;
$$;

comment on function app_private.messaging_unread_count(uuid) is
  'How many messages the caller has not read, across the conversations their inbox lists. Their own messages never count; a muted conversation still does, because mute is a notification preference and not a read marker.';

-- ---------------------------------------------------------------------------------------------------
-- 4. The N8 listing reference resolver
-- ---------------------------------------------------------------------------------------------------
-- A listing referenced inside a conversation has to stay identifiable after it stops being for sale —
-- that is the whole of N8 — and the existing public reader cannot do it, by design: it admits only
-- purchasable listings of active sellers, so a sold listing simply vanishes from it. Hence this reader,
-- which answers for *any* listing id and decides how much of it may be said.
--
-- Two outcomes, and the difference is enforced by the projection rather than by a caller's discipline:
--
--   `available`             approved or active, seller active. The compact card fields: slug, title,
--                           price, currency, and the surface the canonical URL belongs to.
--   `no_longer_available`   everything else — sold, expired, archived, draft, pending review, rejected,
--                           suspended, deleted, and any listing whose seller is not active. The id and
--                           a title, and every other column null.
--
-- **The unavailable projection cannot carry a link**, because it carries no slug: without one there is
-- nothing from which a URL could be built, which is a stronger guarantee than a null URL string. It
-- carries no price, no currency, no media, no seller and no moderation state either.
--
-- **The title is only returned when it has already been public.** A sold, expired or archived listing
-- had a public page under 0011's own rule, so its title is not a secret. A draft, rejected, suspended or
-- deleted listing — or one whose seller was suspended — never had one, or had one withdrawn, so its
-- title is withheld and the surface falls back to the conversation's own
-- `conversations.listing_title_snapshot`, which the specification already names as what keeps the card
-- identifiable. Returning a moderated title here would undo that moderation inside every chat that ever
-- linked to it.
--
-- The URL itself is not built here. `canonical_type` and `slug` are the two values the application's
-- single URL builder needs, and duplicating that builder in SQL would create a second place for public
-- addresses to be decided.
create or replace function app_private.messaging_listing_reference(p_listing_id uuid)
returns table (
  id uuid,
  status text,
  slug text,
  canonical_type text,
  title text,
  price_minor bigint,
  currency_code text,
  currency_minor_unit smallint
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select l.id,
         case
           when public.listing_status_is_purchasable(l.status)
            and public.is_seller_publicly_visible(l.seller_user_id)
           then 'available'
           else 'no_longer_available'
         end,
         case
           when public.listing_status_is_purchasable(l.status)
            and public.is_seller_publicly_visible(l.seller_user_id)
           then l.slug
         end,
         case
           when public.listing_status_is_purchasable(l.status)
            and public.is_seller_publicly_visible(l.seller_user_id)
           then case when l.listing_type_code = 'service' then 'service' else 'product' end
         end,
         -- Only a title that has already been public. See the note above.
         case
           when public.listing_status_is_public(l.status)
            and public.is_seller_publicly_visible(l.seller_user_id)
           then l.title
         end,
         case
           when public.listing_status_is_purchasable(l.status)
            and public.is_seller_publicly_visible(l.seller_user_id)
           then l.price_minor
         end,
         case
           when public.listing_status_is_purchasable(l.status)
            and public.is_seller_publicly_visible(l.seller_user_id)
           then l.currency_code::text
         end,
         case
           when public.listing_status_is_purchasable(l.status)
            and public.is_seller_publicly_visible(l.seller_user_id)
           then c.decimal_places
         end
    from public.listings l
    join public.currencies c on c.code = l.currency_code
   where l.id = p_listing_id;
$$;

comment on function app_private.messaging_listing_reference(uuid) is
  'The N8 resolver for a listing referenced inside a conversation. An available listing returns the compact public card; anything else returns its id, a title only if that title was already public, and the status no_longer_available — no slug, so no URL can be built, and no price, currency, media, seller or moderation detail.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.messaging_inbox(uuid, integer, timestamptz, uuid) from public;
revoke execute on function app_private.messaging_conversation_messages(uuid, uuid, integer, bigint) from public;
revoke execute on function app_private.messaging_unread_count(uuid) from public;
revoke execute on function app_private.messaging_listing_reference(uuid) from public;

grant execute on function app_private.messaging_inbox(uuid, integer, timestamptz, uuid) to app_system;
grant execute on function app_private.messaging_conversation_messages(uuid, uuid, integer, bigint) to app_system;
grant execute on function app_private.messaging_unread_count(uuid) to app_system;
grant execute on function app_private.messaging_listing_reference(uuid) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
