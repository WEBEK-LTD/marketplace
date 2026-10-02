-- 0074 — Support: the requester side (Phase 7-K).
--
-- ---------------------------------------------------------------------------------------------------
-- What the survey found, and what this migration therefore is
-- ---------------------------------------------------------------------------------------------------
-- **No table, column, constraint, index, trigger, policy, permission or setting is created or changed
-- here.** 0028 owns all five support tables, their five triggers, their six policies, the reference
-- generator and the five support writers; 0012 owns the private `support-attachments` bucket and its
-- contract row; 0031 records four of the tables as append-only. Every one of those is read below and none
-- is rewritten. This migration adds functions and nothing else, and it seeds no data.
--
-- **Why it has to exist at all.** `app_system` holds no table privileges anywhere (0003, enforced by
-- 0031's role-boundary contract), so the API cannot read a support table directly — and 0028 defined
-- **no readers**: not a ticket list, not a ticket, not a page of messages, and nothing for attachments. A
-- requester surface is therefore impossible without named SECURITY DEFINER readers, which is the only
-- reason this file is here.
--
-- **The three writers below are wrappers, not a second write path.** Every row this migration writes is
-- written by 0028's own `open_support_ticket`, `post_support_message` and `close_support_ticket`, called
-- unchanged. What the wrappers add is the thing an API boundary needs and those functions do not provide:
-- a requester-ownership test that answers *neutrally*, and an outcome vocabulary instead of a raised
-- exception. Nothing below inserts into `support_tickets`, `support_messages` or `support_ticket_events`;
-- the one table this file inserts into is `support_attachments`, for which 0028 defined no writer at all.
--
-- ---------------------------------------------------------------------------------------------------
-- The requester's transitions, read off 0028 rather than assumed
-- ---------------------------------------------------------------------------------------------------
-- `support_tickets_status_allowed` admits `open`, `pending_agent`, `pending_requester`, `resolved` and
-- `closed`. What a **requester** can reach, and by which writer:
--
--     (none) → open → pending_agent   `open_support_ticket` inserts the row at the column default `open`
--                                     and then, in the same transaction, posts the requester's first
--                                     message through `post_support_message`, whose own `case` moves a
--                                     requester's message to `pending_agent`. So `open` exists for the
--                                     length of one transaction and is never observable: this migration
--                                     performs no transition, it merely records what 0028 already does
--     open|pending_agent|pending_requester → pending_agent
--                                     any later requester message, again `post_support_message`'s own
--                                     `case`. It is not a transition this file chooses or could vary
--     resolved → resolved             a requester message on a resolved ticket is **accepted and changes
--                                     nothing**: `post_support_message` preserves `resolved` and `closed`
--                                     explicitly. Reported rather than worked around — see below
--     closed → (refused)              `post_support_message` raises `restrict_violation`. The wrapper
--                                     turns that into a conflict before the call rather than after
--     any live state → closed         `close_support_ticket`, whose authorization is
--                                     `can_access_support_ticket`, and **0028's own comment names the
--                                     requester first**: "its requester and the agent it is assigned to".
--                                     So requester closure is defined by the authoritative writer, and
--                                     this is it
--
-- **`resolved` is not offered to a requester, and this file cannot write it.** The writer permits either
-- terminal status for anybody who may act on the ticket, so the vocabulary is closed and known; what is
-- not defined anywhere is which of the two a *requester's* closure means. `resolved` is the outcome an
-- agent records — it stamps `resolved_at`, it leaves the ticket outside the agent queue index, and a
-- requester's later message on it moves nothing, so a requester who marked their own ticket resolved and
-- then needed help again would be writing into a state nothing watches. `closed` says what a requester
-- actually means, refuses further messages honestly, and stamps `closed_at`. So
-- `support_ticket_close_for_requester` passes the literal `'closed'` and takes **no status parameter**:
-- there is no argument through which a caller could ask for the other one. Marking a ticket `resolved` is
-- the agent outcome and belongs to 7-L.
--
-- **There is no reopen, and none is invented.** `support_ticket_events_type_allowed` admits a `reopened`
-- event type, and **no function in the repository writes it**: nothing moves a ticket out of `resolved` or
-- `closed`, before or after this migration. A requester whose closed ticket needs more help opens another
-- one; no schema rule forbids that, and no dedupe rule exists to make it awkward.
--
-- ---------------------------------------------------------------------------------------------------
-- What a requester is shown, and what is deliberately withheld
-- ---------------------------------------------------------------------------------------------------
-- `support_internal_notes` appears in **no statement in this file**. It has no requester branch in its
-- policy and no reader here, which is two independent reasons a note cannot reach a requester.
--
-- Nor does anything below return, in any shape:
--
--   * `assigned_to`, `assigned_at` or `membership_version` — who is working on a ticket, and the Realtime
--     membership version that follows a reassignment, are the console's business
--   * `first_response_at` or `priority` — internal triage. The requester sets neither (the wrapper passes
--     no priority, so 0028's `'normal'` default stands) and reading an `urgent` back would disclose how
--     the platform ranks them
--   * `author_user_id` on a message — a message carries `author_role`, which is `requester` or `agent`,
--     and `is_own_message`. An agent's account identifier never leaves the database
--   * `object_path` on an attachment — the path is composed here and re-derived here, and it crosses to a
--     browser exactly once, as the destination of one upload the database authorized
--   * the `support_ticket_events` trail — its `assigned`/`unassigned` rows carry agent account
--     identifiers in `from_value` and `to_value`, so there is no requester-safe projection of it, and a
--     ticket's history is already legible as its messages and its status. 0028's own policy does admit a
--     requester branch on that table; nothing in this repository gives a browser a database session, so
--     that branch is unreachable today, and it is reported for 7-L rather than altered here
--
-- ---------------------------------------------------------------------------------------------------
-- Attachments
-- ---------------------------------------------------------------------------------------------------
-- 0012's `support-attachments` bucket is private and its own contract row says so. 0028 created the
-- table, its append-only trigger and its read policy, and **no writer**, so the minimum secure requester
-- path is added here in the exact shape 6-E and 6-I already use and 7-G extended:
--
--     target → the browser PUTs the bytes to a signed URL → attach
--
--   * **The browser never names a destination.** `support_attachment_target_for_requester` composes the
--     path from the ticket and the message the caller owns plus a fresh `gen_random_uuid()` and an
--     extension derived from the validated content type. Nothing from the request appears in it, so
--     traversal and another ticket's namespace are unexpressible rather than merely refused
--   * **The bucket is the authority on type and size**, read from `storage.buckets` at call time. A
--     bucket that cannot be read authorizes nothing
--   * **Attaching re-derives the prefix** from the caller's own ticket and message and requires the tail
--     to be one plain file name of the shape the target issues, so the only paths a requester can record
--     are ones this function could itself have issued to them
--   * **Reading one takes three agreements in one statement**: the ticket is the caller's, the attachment
--     belongs to a message of *that* ticket, and the identifier in the route is the attachment's own.
--     `support_attachment_for_requester` returns a path for the API to sign and nothing else
--   * A message on a **closed** ticket takes no new attachment, for the same reason it takes no new
--     message. A file uploaded into that race is never recorded and no reader can name it
--
-- ---------------------------------------------------------------------------------------------------
-- Notifications, events and audit
-- ---------------------------------------------------------------------------------------------------
-- **No notification.** `notifications.category` admits `support` and `subject_type` admits
-- `support_ticket`, and that is the whole of it: the repository defines no support notification event
-- type, no template key and no writer, and `public.email_templates` is empty. 0029's
-- `create_notification` is not called anywhere below, and inventing an event type or a sentence to put in
-- one would be inventing user-facing semantics.
--
-- **The outbox events are 0028's own**, emitted inside the writers this file calls: `support_ticket.opened`,
-- `support_ticket.message_posted` and `support_ticket.closed`. Nothing here enqueues an event of its own.
--
-- **The audit trail is 0028's own too.** `support_tickets_audit` records the row change with the subject
-- redacted, `tg_support_tickets_created` writes the `created` event and `tg_support_tickets_membership`
-- writes `status_changed`; `post_support_message` writes `message_posted` itself. No wrapper below writes
-- an event or an audit row, so there is no second trail and nothing is recorded twice. One consequence is
-- reported rather than papered over: `tg_support_tickets_membership` writes `status_changed` with **no
-- actor**, so a requester's closure records the transition and its time but not who made it — the same
-- shape as 7-J's staff closure, and the same instruction applies (reuse the existing audit behaviour,
-- invent no second path).

-- ---------------------------------------------------------------------------------------------------
-- 1. The requester's tickets
-- ---------------------------------------------------------------------------------------------------
-- Newest first, over 0028's own `support_tickets_requester` index, which is `(requester_user_id,
-- created_at desc)`. The predicate is `requester_user_id = p_user_id` fixed in the statement, so there is
-- no argument a caller could supply that would show them somebody else's list, and a user with no tickets
-- gets zero rows rather than an error.
create or replace function app_private.support_tickets_for_requester(
  p_user_id uuid,
  p_limit integer default 20,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  id uuid,
  reference text,
  subject text,
  category text,
  status text,
  message_count integer,
  attachment_count integer,
  last_message_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select t.id,
         t.reference,
         t.subject,
         t.category,
         t.status,
         t.message_count,
         (select count(*)::integer
            from public.support_attachments a
            join public.support_messages m on m.id = a.support_message_id
           where m.support_ticket_id = t.id),
         t.last_message_at,
         t.resolved_at,
         t.closed_at,
         t.created_at
    from public.support_tickets t
   where t.requester_user_id = p_user_id
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (t.created_at, t.id) < (p_cursor_created_at, p_cursor_id)
     )
   order by t.created_at desc, t.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

comment on function app_private.support_tickets_for_requester(uuid, integer, timestamptz, uuid) is
  'One page of the support tickets an account raised, newest first, over 0028''s own support_tickets_requester index. Scoped to requester_user_id in the statement. It returns no assigned agent, no assignment time, no priority, no first-response time and no membership version, and no account identifier of any kind.';

-- ---------------------------------------------------------------------------------------------------
-- 2. One ticket
-- ---------------------------------------------------------------------------------------------------
-- A ticket that is not the caller's and a ticket that does not exist are the same answer, decided by the
-- same statement: `not_found` for both. There is no branch here that could tell them apart, so there is
-- none that could leak the difference — which is what makes guessing an identifier useless.
create or replace function app_private.support_ticket_for_requester(
  p_user_id uuid,
  p_ticket_id uuid
) returns table (
  outcome text,
  id uuid,
  reference text,
  subject text,
  category text,
  status text,
  message_count integer,
  last_message_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  ticket public.support_tickets;
begin
  if p_user_id is null or p_ticket_id is null then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text, null::text,
                        null::integer, null::timestamptz, null::timestamptz, null::timestamptz,
                        null::timestamptz;
    return;
  end if;

  select * into ticket
    from public.support_tickets t
   where t.id = p_ticket_id
     and t.requester_user_id = p_user_id;

  if ticket.id is null then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text, null::text,
                        null::integer, null::timestamptz, null::timestamptz, null::timestamptz,
                        null::timestamptz;
    return;
  end if;

  return query select 'found'::text,
                      ticket.id,
                      ticket.reference,
                      ticket.subject,
                      ticket.category,
                      ticket.status,
                      ticket.message_count,
                      ticket.last_message_at,
                      ticket.resolved_at,
                      ticket.closed_at,
                      ticket.created_at;
end;
$$;

comment on function app_private.support_ticket_for_requester(uuid, uuid) is
  'One support ticket, for the account that raised it and nobody else. A ticket belonging to somebody else and a ticket that does not exist both return not_found. It returns no assigned agent, no priority, no first-response time and no internal note — support_internal_notes appears in no statement of this function.';

-- ---------------------------------------------------------------------------------------------------
-- 3. One ticket's conversation
-- ---------------------------------------------------------------------------------------------------
-- Authorization is the ticket's, tested inside the statement: a caller who is not its requester gets zero
-- rows, and so does a ticket id that names nothing — the same answer again.
--
-- The page is chosen newest-first and returned oldest-first, exactly as 0053's conversation reader does
-- and for the same reason: a conversation opens at its newest end and pages backwards, so each request
-- asks for the messages immediately before the cursor and the caller renders what comes back in reading
-- order without re-sorting it. The total order is `(created_at, id)` — `support_messages` has no sequence
-- column, `created_at` is `not null` and the identifier is unique, so the pair identifies exactly one row
-- and two messages written in the same transaction are ordered rather than skipped or repeated.
--
-- Attachments travel as the three display fields and the identifier the link operation takes. The object
-- path is not among them.
create or replace function app_private.support_ticket_messages_for_requester(
  p_user_id uuid,
  p_ticket_id uuid,
  p_limit integer default 20,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  id uuid,
  author_role text,
  is_own_message boolean,
  body text,
  created_at timestamptz,
  attachments jsonb
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with allowed as (
    select exists (
      select 1
        from public.support_tickets t
       where t.id = p_ticket_id
         and t.requester_user_id = p_user_id
    ) as may_read
  ),
  bounded as (
    select least(greatest(coalesce(p_limit, 20), 1), 51) as row_limit
  ),
  page as (
    select m.id, m.author_role, m.author_user_id, m.body, m.created_at
      from public.support_messages m
     cross join allowed a
     cross join bounded b
     where a.may_read
       and m.support_ticket_id = p_ticket_id
       -- Strictly before the cursor, in the same total order, so a page never repeats a message.
       and (
         p_cursor_created_at is null
         or p_cursor_id is null
         or (m.created_at, m.id) < (p_cursor_created_at, p_cursor_id)
       )
     order by m.created_at desc, m.id desc
     limit (select row_limit from bounded)
  )
  select page.id,
         page.author_role,
         -- Saves every caller from re-deriving it, and keeps "whose message is this" one answer.
         page.author_user_id is not distinct from p_user_id,
         page.body,
         page.created_at,
         coalesce(
           (select jsonb_agg(
                     jsonb_build_object(
                       'id', a.id,
                       'originalFilename', a.original_filename,
                       'contentType', a.content_type,
                       'byteSize', a.byte_size
                     )
                     order by a.created_at, a.id
                   )
              from public.support_attachments a
             where a.support_message_id = page.id),
           '[]'::jsonb
         )
    from page
   order by page.created_at, page.id;
$$;

comment on function app_private.support_ticket_messages_for_requester(uuid, uuid, integer, timestamptz, uuid) is
  'One page of a ticket''s conversation for the account that raised it, chosen newest-first from the cursor and returned in reading order. Zero rows for a ticket that is not theirs and for one that does not exist. A message carries its role and whether it is the caller''s own; it never carries an author identifier. Internal notes are a different table and appear in no statement here, and an attachment''s object path is not returned.';

-- ---------------------------------------------------------------------------------------------------
-- 4. Opening a ticket
-- ---------------------------------------------------------------------------------------------------
-- A wrapper around 0028's `open_support_ticket`, which does the whole write: the ticket at its default
-- status, the reference through D12's generator, the first message through `post_support_message` — and
-- therefore the `created` and `message_posted` events, the counters and the move to `pending_agent` — and
-- the `support_ticket.opened` outbox event. None of that is repeated here.
--
-- What the wrapper adds is the boundary: every value is checked against the column constraint that governs
-- it *before* the call, so a subject of 300 characters is an `invalid` outcome rather than a raised
-- exception arriving at an API as a 500, and the outcome vocabulary is the one every Phase 6 and 7 writer
-- already speaks.
--
-- **It takes no priority, no assignee, no status and no order.** `p_priority` is left to 0028's `'normal'`
-- default, because a requester does not triage; `assigned_to` is not a parameter of anything here; the
-- status is the column default; and the writer's optional `p_order_id` is deliberately not exposed, since
-- nothing in this application yet gives a buyer a list of their orders to name one from.
create or replace function app_private.support_ticket_open_for_requester(
  p_user_id uuid,
  p_subject text,
  p_category text,
  p_body text
) returns table (
  outcome text,
  ticket_id uuid,
  message_id uuid,
  reference text,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_ticket_id uuid;
  v_message_id uuid;
  v_reference text;
  v_status text;
begin
  if p_user_id is null then
    return query select 'invalid'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;
  -- `support_tickets_subject_length`, restated as a refusal rather than left to become an exception.
  if p_subject is null or length(btrim(p_subject)) < 1 or length(btrim(p_subject)) > 200 then
    return query select 'invalid'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;
  -- `support_messages_body_length`.
  if p_body is null or length(btrim(p_body)) < 1 or length(btrim(p_body)) > 8000 then
    return query select 'invalid'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;
  -- `support_tickets_category_allowed`, written out so this function refuses exactly what the table
  -- refuses. A ninth value is not creatable here or there.
  if p_category is null or p_category not in (
    'account', 'orders', 'payments', 'payouts', 'listings', 'verification', 'technical', 'other'
  ) then
    return query select 'invalid'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;

  begin
    -- 0028's writer, unchanged, with its own defaults for priority and the related order.
    v_ticket_id := app_private.open_support_ticket(p_user_id, btrim(p_subject), p_category, btrim(p_body));
  exception
    when check_violation or foreign_key_violation or restrict_violation or invalid_parameter_value then
      return query select 'invalid'::text, null::uuid, null::uuid, null::text, null::text;
      return;
  end;

  -- Read back what that writer created, rather than assuming it: the status is whatever
  -- `post_support_message` left the row at, and the reference is the generator's.
  select t.reference, t.status into v_reference, v_status
    from public.support_tickets t where t.id = v_ticket_id;

  -- The one message the writer posted, so an attachment can be recorded against it without a second
  -- round trip that would have to find it by guessing.
  select m.id into v_message_id
    from public.support_messages m
   where m.support_ticket_id = v_ticket_id
   order by m.created_at, m.id
   limit 1;

  return query select 'created'::text, v_ticket_id, v_message_id, v_reference, v_status;
end;
$$;

comment on function app_private.support_ticket_open_for_requester(uuid, text, text, text) is
  'Opens one support ticket for a signed-in requester by calling 0028''s open_support_ticket unchanged, and reports the outcome instead of raising. It validates the subject, the body and the category against the constraints that govern them, takes no priority, no assignee, no status and no related order, and returns the first message''s identifier so an attachment can be recorded against it.';

-- ---------------------------------------------------------------------------------------------------
-- 5. Replying
-- ---------------------------------------------------------------------------------------------------
-- The ownership test is this function's, and the write is 0028's. `post_support_message` would treat any
-- account that is not the requester as an agent and then refuse it for want of access — so calling it with
-- somebody else's ticket is already safe — but the answer would be an exception that names the ticket.
-- Checking first turns that into the neutral `not_found` this surface uses everywhere.
--
-- The state rule is the writer's and is not restated: this function refuses a `closed` ticket because the
-- writer does, and does not touch the `resolved` case at all — a message on a resolved ticket is accepted
-- and leaves the status where it is, which is `post_support_message`'s own `case` and not a behaviour this
-- file chose.
create or replace function app_private.support_message_post_for_requester(
  p_user_id uuid,
  p_ticket_id uuid,
  p_body text
) returns table (
  outcome text,
  message_id uuid,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  ticket public.support_tickets;
  v_message_id uuid;
  v_status text;
begin
  if p_user_id is null or p_ticket_id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  if p_body is null or length(btrim(p_body)) < 1 or length(btrim(p_body)) > 8000 then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;

  -- Locked, so two replies and a staff closure serialize rather than interleave.
  select * into ticket
    from public.support_tickets t
   where t.id = p_ticket_id
     and t.requester_user_id = p_user_id
   for update;

  if ticket.id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  if ticket.status = 'closed' then
    return query select 'conflict'::text, null::uuid, null::text;
    return;
  end if;

  begin
    v_message_id := app_private.post_support_message(p_ticket_id, p_user_id, btrim(p_body));
  exception
    when check_violation or restrict_violation or foreign_key_violation then
      return query select 'invalid'::text, null::uuid, null::text;
      return;
  end;

  select t.status into v_status from public.support_tickets t where t.id = p_ticket_id;
  return query select 'posted'::text, v_message_id, v_status;
end;
$$;

comment on function app_private.support_message_post_for_requester(uuid, uuid, text) is
  'Adds one requester message to a ticket that account raised, by calling 0028''s post_support_message unchanged. A ticket belonging to somebody else and one that does not exist are both not_found; a closed ticket is a conflict, which is the writer''s own rule reported before it becomes an exception. The author role, the counters, the status move and the event are all the writer''s.';

-- ---------------------------------------------------------------------------------------------------
-- 6. Closing one's own ticket
-- ---------------------------------------------------------------------------------------------------
-- 0028's `close_support_ticket` authorizes through `can_access_support_ticket`, which is "its requester and
-- the agent it is assigned to, and nobody else" — so a requester closure is the authoritative writer's own
-- behaviour and this wrapper performs it with the status pinned as the literal `'closed'`.
--
-- **There is no status parameter**, so this function cannot record `resolved`: that is the agent outcome,
-- it stamps a different column, and on this surface it would put a ticket into a state where a requester's
-- later message moves nothing. A requester who needs help again opens another ticket; nothing here reopens
-- one, and no function in the repository does.
create or replace function app_private.support_ticket_close_for_requester(
  p_user_id uuid,
  p_ticket_id uuid
) returns table (
  outcome text,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  ticket public.support_tickets;
  v_status text;
begin
  if p_user_id is null or p_ticket_id is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  select * into ticket
    from public.support_tickets t
   where t.id = p_ticket_id
     and t.requester_user_id = p_user_id
   for update;

  if ticket.id is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;
  if ticket.status = 'closed' then
    return query select 'conflict'::text, null::text;
    return;
  end if;

  begin
    -- The status is a literal here. Nothing above the database chooses it.
    v_status := app_private.close_support_ticket(p_ticket_id, 'closed', p_user_id);
  exception
    when restrict_violation or invalid_parameter_value or check_violation then
      return query select 'conflict'::text, null::text;
      return;
  end;

  return query select 'closed'::text, v_status;
end;
$$;

comment on function app_private.support_ticket_close_for_requester(uuid, uuid) is
  'Closes a ticket the calling account raised, by calling 0028''s close_support_ticket with the status pinned as the literal closed. There is no status parameter, so resolved — the agent outcome — cannot be recorded here. A ticket that is not theirs is not_found and an already closed one is a conflict. It writes no event and no audit row of its own: 0028''s triggers record the transition.';

-- ---------------------------------------------------------------------------------------------------
-- 7. Authorizing one attachment upload
-- ---------------------------------------------------------------------------------------------------
-- Writes nothing. It decides whether this account may attach a file to this message of this ticket, reads
-- the bucket's own limits, and composes the one path the upload may go to.
--
-- Every component of that path is the server's: the bucket name from 0012's contract, the ticket and the
-- message the caller was found to own, a fresh `gen_random_uuid()` and an extension derived from the
-- content type this function validated. Nothing from the request appears in it.
create or replace function app_private.support_attachment_target_for_requester(
  p_user_id uuid,
  p_ticket_id uuid,
  p_message_id uuid,
  p_content_type text,
  p_byte_size bigint
) returns table (
  outcome text,
  bucket_id text,
  object_path text,
  max_byte_size bigint
)
language plpgsql
-- Deliberately not `stable`: it composes a fresh `gen_random_uuid()` into the path, so two calls must be
-- allowed to differ. 6-E's and 6-I's equivalents are volatile for the same reason.
security definer
set search_path = pg_catalog, public
as $$
declare
  v_bucket text := 'support-attachments';
  v_status text;
  v_limit bigint;
  v_allowed text[];
  v_extension text;
begin
  if p_user_id is null or p_ticket_id is null or p_message_id is null then
    return query select 'not_found'::text, null::text, null::text, null::bigint;
    return;
  end if;

  -- The ticket must be the caller's and the message must be one of *their own* messages on it. An agent's
  -- message is not a place a requester may add a file, and the `author_role` test says so without needing
  -- to know who the agent is.
  select t.status into v_status
    from public.support_messages m
    join public.support_tickets t on t.id = m.support_ticket_id
   where m.id = p_message_id
     and m.support_ticket_id = p_ticket_id
     and t.requester_user_id = p_user_id
     and m.author_user_id = p_user_id
     and m.author_role = 'requester';

  if v_status is null then
    return query select 'not_found'::text, null::text, null::text, null::bigint;
    return;
  end if;
  if v_status = 'closed' then
    return query select 'conflict'::text, null::text, null::text, null::bigint;
    return;
  end if;

  -- The bucket is the authority on what may be stored in it, read at call time rather than copied here.
  select b.file_size_limit, b.allowed_mime_types into v_limit, v_allowed
    from storage.buckets b
   where b.id = v_bucket;

  if v_limit is null or v_allowed is null then
    -- Authorizing an upload into a bucket whose rules cannot be read would be authorizing an unbounded one.
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;
  if p_content_type is null or not (p_content_type = any (v_allowed)) then
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;
  if p_byte_size is null or p_byte_size <= 0 or p_byte_size > v_limit then
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;

  -- The extension follows from the content type, so the stored name cannot disagree with what was declared.
  v_extension := case p_content_type
    when 'image/jpeg' then 'jpg'
    when 'image/png' then 'png'
    when 'image/webp' then 'webp'
    when 'application/pdf' then 'pdf'
  end;
  if v_extension is null then
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;

  return query select
    'authorized'::text,
    v_bucket,
    v_bucket || '/' || p_ticket_id::text || '/' || p_message_id::text || '/'
      || gen_random_uuid()::text || '.' || v_extension,
    v_limit;
end;
$$;

comment on function app_private.support_attachment_target_for_requester(uuid, uuid, uuid, text, bigint) is
  'Authorizes one support attachment upload and returns the object path to upload to. The path is composed entirely server-side from 0012''s bucket, the ticket and the requester''s own message, a fresh random name and an extension derived from the validated content type, so no request can choose a path, traverse out of its namespace or reach another ticket''s. The type and size limits are read from the bucket row. A message that is not the caller''s own, on a ticket that is not theirs, is not_found; a closed ticket is a conflict. Writes nothing.';

-- ---------------------------------------------------------------------------------------------------
-- 8. Recording an upload that happened
-- ---------------------------------------------------------------------------------------------------
-- The confirming half. The prefix is rebuilt from the caller's own ticket and message, so the only paths a
-- requester can record are ones the target function could itself have issued to them; and the remainder
-- must be one plain file name of the shape it issues, which is what makes `..`, a nested path and an
-- encoded separator unrepresentable rather than merely refused.
create or replace function app_private.support_attachment_attach_for_requester(
  p_user_id uuid,
  p_ticket_id uuid,
  p_message_id uuid,
  p_object_path text,
  p_original_filename text,
  p_content_type text,
  p_byte_size bigint
) returns table (
  outcome text,
  attachment_id uuid,
  attachment_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_bucket text := 'support-attachments';
  v_status text;
  v_limit bigint;
  v_allowed text[];
  v_expected_prefix text;
  v_tail text;
  v_attachment_id uuid;
begin
  if p_user_id is null or p_ticket_id is null or p_message_id is null then
    return query select 'not_found'::text, null::uuid, null::integer;
    return;
  end if;

  select t.status into v_status
    from public.support_messages m
    join public.support_tickets t on t.id = m.support_ticket_id
   where m.id = p_message_id
     and m.support_ticket_id = p_ticket_id
     and t.requester_user_id = p_user_id
     and m.author_user_id = p_user_id
     and m.author_role = 'requester'
   for update of t;

  if v_status is null then
    return query select 'not_found'::text, null::uuid, null::integer;
    return;
  end if;
  if v_status = 'closed' then
    return query select 'conflict'::text, null::uuid, null::integer;
    return;
  end if;

  select b.file_size_limit, b.allowed_mime_types into v_limit, v_allowed
    from storage.buckets b
   where b.id = v_bucket;

  if v_limit is null or v_allowed is null then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;
  if p_content_type is null or not (p_content_type = any (v_allowed)) then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;
  if p_byte_size is null or p_byte_size <= 0 or p_byte_size > v_limit then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;

  v_expected_prefix := v_bucket || '/' || p_ticket_id::text || '/' || p_message_id::text || '/';
  if p_object_path is null or left(p_object_path, length(v_expected_prefix)) <> v_expected_prefix then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;

  v_tail := substr(p_object_path, length(v_expected_prefix) + 1);
  if v_tail !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|pdf)$' then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;

  -- One object, one row. `support_attachments` carries **no unique index on `object_path`** — 0028 defined
  -- none, and adding one would be a change to an existing table rather than an addition to the boundary —
  -- so the rule is applied here instead: a confirmation that arrives twice records the file once. The
  -- ticket is already locked above, so the two attempts of a retrying client serialize and the second one
  -- sees the first one's row.
  if exists (select 1 from public.support_attachments a where a.object_path = p_object_path) then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;

  begin
    insert into public.support_attachments (
      support_message_id, object_path, original_filename, content_type, byte_size
    ) values (
      p_message_id,
      p_object_path,
      nullif(btrim(coalesce(p_original_filename, '')), ''),
      p_content_type,
      p_byte_size
    )
    returning id into v_attachment_id;
  exception
    when unique_violation or check_violation or foreign_key_violation or restrict_violation then
      return query select 'invalid'::text, null::uuid, null::integer;
      return;
  end;

  return query select 'attached'::text,
                      v_attachment_id,
                      (select count(*)::integer from public.support_attachments a
                        where a.support_message_id = p_message_id);
end;
$$;

comment on function app_private.support_attachment_attach_for_requester(uuid, uuid, uuid, text, text, text, bigint) is
  'Records one uploaded file against a message the calling account wrote on a ticket it raised. The expected prefix is rebuilt from that ticket and that message and the remainder must be one plain file name of the shape the target function issues, so a path for another ticket, another message, another bucket or with a traversal in it cannot match. The type and size are checked against the bucket again, and a path already recorded is refused rather than recorded twice — support_attachments has no unique index on object_path, so that rule lives here. It writes no event: support_ticket_events has no attachment type and none is invented.';

-- ---------------------------------------------------------------------------------------------------
-- 9. Reading one attachment back
-- ---------------------------------------------------------------------------------------------------
-- Three agreements in one statement: the ticket is the caller's, the attachment hangs off a message *of
-- that ticket*, and the attachment is the one the route named. Anything else is `not_found`, so an
-- attachment identifier cannot be spent against another ticket's page and a guessed one discloses nothing.
--
-- It returns a location for the API to sign and nothing else. The bucket stays private; a signed read is
-- for one object for a few minutes, and it is the API that asks the provider for it.
create or replace function app_private.support_attachment_for_requester(
  p_user_id uuid,
  p_ticket_id uuid,
  p_attachment_id uuid
) returns table (
  outcome text,
  bucket_id text,
  object_path text,
  content_type text,
  original_filename text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_path text;
  v_content_type text;
  v_filename text;
begin
  if p_user_id is null or p_ticket_id is null or p_attachment_id is null then
    return query select 'not_found'::text, null::text, null::text, null::text, null::text;
    return;
  end if;

  select a.object_path, a.content_type, a.original_filename
    into v_path, v_content_type, v_filename
    from public.support_attachments a
    join public.support_messages m on m.id = a.support_message_id
    join public.support_tickets t on t.id = m.support_ticket_id
   where a.id = p_attachment_id
     and m.support_ticket_id = p_ticket_id
     and t.requester_user_id = p_user_id;

  if v_path is null then
    return query select 'not_found'::text, null::text, null::text, null::text, null::text;
    return;
  end if;

  return query select 'authorized'::text, 'support-attachments'::text, v_path, v_content_type, v_filename;
end;
$$;

comment on function app_private.support_attachment_for_requester(uuid, uuid, uuid) is
  'The location of one attachment on a ticket the calling account raised, for the API to sign a short-lived read of. The attachment, its message''s ticket and the ticket in the route must all agree, so an identifier cannot be spent against another ticket and an attachment of somebody else''s ticket is not_found. It is the only function on this surface that returns an object path, and it returns it to the API, never to a browser. Writes nothing.';

-- ---------------------------------------------------------------------------------------------------
-- Least privilege
-- ---------------------------------------------------------------------------------------------------
revoke all on function app_private.support_tickets_for_requester(uuid, integer, timestamptz, uuid) from public;
revoke all on function app_private.support_ticket_for_requester(uuid, uuid) from public;
revoke all on function app_private.support_ticket_messages_for_requester(uuid, uuid, integer, timestamptz, uuid) from public;
revoke all on function app_private.support_ticket_open_for_requester(uuid, text, text, text) from public;
revoke all on function app_private.support_message_post_for_requester(uuid, uuid, text) from public;
revoke all on function app_private.support_ticket_close_for_requester(uuid, uuid) from public;
revoke all on function app_private.support_attachment_target_for_requester(uuid, uuid, uuid, text, bigint) from public;
revoke all on function app_private.support_attachment_attach_for_requester(uuid, uuid, uuid, text, text, text, bigint) from public;
revoke all on function app_private.support_attachment_for_requester(uuid, uuid, uuid) from public;

grant execute on function app_private.support_tickets_for_requester(uuid, integer, timestamptz, uuid) to app_system;
grant execute on function app_private.support_ticket_for_requester(uuid, uuid) to app_system;
grant execute on function app_private.support_ticket_messages_for_requester(uuid, uuid, integer, timestamptz, uuid) to app_system;
grant execute on function app_private.support_ticket_open_for_requester(uuid, text, text, text) to app_system;
grant execute on function app_private.support_message_post_for_requester(uuid, uuid, text) to app_system;
grant execute on function app_private.support_ticket_close_for_requester(uuid, uuid) to app_system;
grant execute on function app_private.support_attachment_target_for_requester(uuid, uuid, uuid, text, bigint) to app_system;
grant execute on function app_private.support_attachment_attach_for_requester(uuid, uuid, uuid, text, text, text, bigint) to app_system;
grant execute on function app_private.support_attachment_for_requester(uuid, uuid, uuid) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
