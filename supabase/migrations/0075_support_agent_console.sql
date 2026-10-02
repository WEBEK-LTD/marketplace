-- 0075 — Support: the agent console (Phase 7-L).
--
-- ---------------------------------------------------------------------------------------------------
-- What the survey found, and what this migration therefore is
-- ---------------------------------------------------------------------------------------------------
-- **No table, column, constraint, index, trigger, policy, permission or setting is created or changed
-- here.** 0028 owns all five support tables, their five triggers, their seven policies, the reference
-- generator and the five support writers; 0012 owns the private `support-attachments` bucket; 0031
-- records four of the tables as append-only; 0033 seeds `support.ticket.read` and
-- `support.ticket.manage` and grants both to `admin`, `super_admin` and `support_agent`. 0074 added the
-- requester's nine functions. Every one of those is read below and none is rewritten.
--
-- **Why it has to exist.** `app_system` holds no table privileges anywhere (0003, enforced by 0031's
-- role-boundary contract) and carries no claims, so the agent side cannot read a support table directly
-- and cannot be gated by `public.has_permission()` — which reads a JWT. The console therefore needs
-- named SECURITY DEFINER readers that take the staff account and the assurance level as parameters, which
-- is the shape 7-F established, 7-G reused and 7-J reused again. That is the only reason this file is here.
--
-- **The four writers below are wrappers, not a second write path.** Every row they write is written by
-- 0028's own `assign_support_ticket`, `post_support_message`, `add_support_internal_note` and
-- `close_support_ticket`, called unchanged. What the wrappers add is the authorization those functions
-- deliberately do not perform — `support.ticket.manage` at `aal2`, tested in the database against the
-- account the API established — and an outcome vocabulary instead of a raised exception. Nothing below
-- inserts into any support table.
--
-- **No new permission.** The two 0033 keys express the whole of this console: `read` opens the queue, the
-- ticket, the conversation and the internal notes (which is 0028's own choice — `support_internal_notes`
-- is gated on *read* in its policy), and `manage` is required for every one of the four writes. There was
-- no least-privilege gap that needed a third key, so none was created.
--
-- ---------------------------------------------------------------------------------------------------
-- The authorization model, read off 0028's policies rather than assumed
-- ---------------------------------------------------------------------------------------------------
-- Every agent-side policy in 0028 is the same predicate:
--
--     has_permission('support.ticket.read'|'…manage') and is_aal2()
--       and (assigned_to = current_user_id() or assigned_to is null)
--
-- So **what an agent may see is: the tickets assigned to them, and the tickets assigned to nobody.** A
-- ticket assigned to another agent is not theirs to read, reply to or close. That is the whole of the
-- queue-membership rule, and it is *automatic* rather than explicit: there is no membership table, no
-- team, no routing rule and nothing to join — a ticket is in an agent's reach because of its
-- `assigned_to` column and for no other reason. Every reader below restates exactly that predicate in
-- its own statement, and returns **zero rows** rather than an error when it does not hold.
--
-- `public.can_access_support_ticket(ticket, user)` is narrower still: "its requester and the agent it is
-- assigned to". The three writers that call it therefore refuse an **unassigned** ticket — which is
-- 0028's own comment: "an agent who wants to act on a queued ticket assigns it first". That is not a rule
-- this migration invents; it is why claiming exists as its own operation.
--
-- ---------------------------------------------------------------------------------------------------
-- The agent's transitions, read off 0028's writers
-- ---------------------------------------------------------------------------------------------------
--     open → pending_agent        `assign_support_ticket`'s own `case`, when a ticket is claimed. The
--                                 only transition claiming performs, and it performs no other
--     (assignment, no status move) claiming a ticket that is already `pending_agent`,
--                                 `pending_requester` or `resolved` moves the assignee and nothing else
--     pending_agent |
--     pending_requester → pending_requester
--                                 an agent's reply, `post_support_message`'s own `case`; it also stamps
--                                 `first_response_at` the first time an agent answers
--     resolved → resolved         an agent's reply on a resolved ticket is accepted and moves nothing —
--                                 the writer preserves `resolved` explicitly
--     closed → (refused)          the writer raises `restrict_violation`
--     any non-closed → resolved   `close_support_ticket(…, 'resolved', …)`, which stamps `resolved_at`
--     any non-closed → closed     `close_support_ticket(…, 'closed', …)`, which stamps `closed_at`
--     resolved → closed           the same call; 0028's `support_tickets_resolved_has_time` is written
--                                 for exactly this ("a resolved ticket may go on to be closed")
--
-- **`resolved` and `closed` are the agent's two outcomes and the only statuses this file passes.** They
-- are checked against those two literals before the call, so no other value can reach the writer.
--
-- **There is no reopen, and none is invented.** Nothing in the repository moves a ticket out of `closed`,
-- and `support_ticket_events_type_allowed`'s `reopened` type is still written by nothing. An agent who
-- needs a closed ticket worked again has no operation here, which is what 7-K reported and what remains
-- true.
--
-- **Releasing a ticket is `assign_support_ticket(ticket, null)`** — the writer's own null branch, which
-- clears the assignee and the stamp, bumps the membership version and records `unassigned`. It changes no
-- status at all: a released ticket keeps the status it had, so a released `pending_agent` ticket is back in
-- the queue and a released `pending_requester` one is not. That is the writer's behaviour, not a choice.
--
-- ---------------------------------------------------------------------------------------------------
-- Ordering, and the one thing the schema's own index cannot be used for
-- ---------------------------------------------------------------------------------------------------
-- `support_tickets_queue` is `(status, priority desc, created_at) where status in ('open','pending_agent')`
-- and the queue reader uses that partial index. Its `priority desc` is **not** used as an ordering,
-- and this is a finding rather than a preference: `priority` is `text`, so `desc` orders it lexically —
-- `urgent`, `normal`, `low`, `high` — which puts `low` ahead of `high` and expresses nothing about
-- severity. Ordering a queue by it would present a nonsense ranking as if it meant something. Turning it
-- into a real ranking needs a severity mapping the schema does not contain, and inventing one is
-- forbidden, so the queue is ordered **oldest first** — `created_at, id`, total and deterministic — and
-- `priority` is returned as a fact about the ticket for a colleague to read.
--
-- ---------------------------------------------------------------------------------------------------
-- What the console is not given
-- ---------------------------------------------------------------------------------------------------
--   * **No other agent's identity.** No reader returns `assigned_to`. A ticket reports `is_mine` and
--     `is_assigned`, both derived from the account the API established, and an internal note reports
--     `is_own_note`. A colleague's account id is in no result type on this surface.
--   * **No membership history and no event trail.** `membership_version` is returned by nothing, and
--     `support_ticket_events` is read by nothing here: its `assigned`/`unassigned` rows carry account
--     identifiers in `from_value`/`to_value`, and a ticket's history is legible as its conversation, its
--     status and its notes.
--   * **No requester account identifier.** A ticket reports the requester's display name, as 7-J's admin
--     detail reports the buyer's, and nothing else about them.
--   * **No object path on a message.** The one function that returns a path returns it to the API, for
--     signing, and only when the attachment, its message's ticket and the ticket in the route agree.

-- ---------------------------------------------------------------------------------------------------
-- 1. The two staff predicates
-- ---------------------------------------------------------------------------------------------------
-- 0003's own rule with the assurance level supplied instead of read from a claim, and the permission key
-- as a literal so no caller can name a different one. The same shape as 0072's two predicates.
create or replace function app_private.support_staff_can_read(
  p_user_id uuid,
  p_is_aal2 boolean
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.user_roles ur
      join public.roles r on r.key = ur.role_key
      join public.role_permissions rp on rp.role_key = r.key
     where ur.user_id = p_user_id
       and ur.revoked_at is null
       and (ur.expires_at is null or ur.expires_at > now())
       and rp.permission_key = 'support.ticket.read'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.support_staff_can_read(uuid, boolean) is
  'True when the account holds support.ticket.read in a session strong enough for the role that grants it. The key is a literal and the assurance level is a parameter, because app_system carries no claims. A predicate: it reads no ticket and writes nothing.';

create or replace function app_private.support_staff_can_manage(
  p_user_id uuid,
  p_is_aal2 boolean
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.user_roles ur
      join public.roles r on r.key = ur.role_key
      join public.role_permissions rp on rp.role_key = r.key
     where ur.user_id = p_user_id
       and ur.revoked_at is null
       and (ur.expires_at is null or ur.expires_at > now())
       and rp.permission_key = 'support.ticket.manage'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.support_staff_can_manage(uuid, boolean) is
  'True when the account holds support.ticket.manage in a session strong enough for the role that grants it. Required by every write on the agent console; reading is governed by the read key instead.';

-- ---------------------------------------------------------------------------------------------------
-- 2. The shared queue
-- ---------------------------------------------------------------------------------------------------
-- Tickets assigned to nobody, in the two statuses 0028's own partial index covers, **oldest first**. It is
-- the shared queue rather than one agent's: membership is the `assigned_to is null` column and nothing
-- else, so there is no routing rule here and none to invent.
create or replace function app_private.support_queue_for_agent(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_limit integer default 20,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  id uuid,
  reference text,
  subject text,
  category text,
  priority text,
  status text,
  requester_name text,
  message_count integer,
  attachment_count integer,
  note_count integer,
  last_message_at timestamptz,
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
         t.priority,
         t.status,
         p.display_name,
         t.message_count,
         (select count(*)::integer
            from public.support_attachments a
            join public.support_messages m on m.id = a.support_message_id
           where m.support_ticket_id = t.id),
         (select count(*)::integer from public.support_internal_notes n
           where n.support_ticket_id = t.id),
         t.last_message_at,
         t.created_at
    from public.support_tickets t
    left join public.profiles p on p.id = t.requester_user_id
   where app_private.support_staff_can_read(p_user_id, p_is_aal2)
     and t.assigned_to is null
     and t.status in ('open', 'pending_agent')
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (t.created_at, t.id) > (p_cursor_created_at, p_cursor_id)
     )
   order by t.created_at, t.id
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

comment on function app_private.support_queue_for_agent(uuid, boolean, integer, timestamptz, uuid) is
  'One page of the shared support queue — tickets assigned to nobody, in the two statuses 0028''s own support_tickets_queue index covers — oldest first, for a caller holding support.ticket.read at aal2. Zero rows for anybody else. It returns the requester''s display name and no account identifier, no assignee, no membership version and no event. priority is returned as a fact, not as an ordering: the index''s priority desc is a lexical order over text and expresses no severity.';

-- ---------------------------------------------------------------------------------------------------
-- 3. The agent's own tickets
-- ---------------------------------------------------------------------------------------------------
-- Everything assigned to the caller, in any status, newest first, over 0028's `support_tickets_assigned`
-- index. A separate function rather than a filter parameter, for the reason 7-I's two lists are separate:
-- the predicate is fixed in the statement, so there is no argument that could show one agent another's
-- work.
create or replace function app_private.support_tickets_assigned_to_agent(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_limit integer default 20,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  id uuid,
  reference text,
  subject text,
  category text,
  priority text,
  status text,
  requester_name text,
  message_count integer,
  attachment_count integer,
  note_count integer,
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
         t.priority,
         t.status,
         p.display_name,
         t.message_count,
         (select count(*)::integer
            from public.support_attachments a
            join public.support_messages m on m.id = a.support_message_id
           where m.support_ticket_id = t.id),
         (select count(*)::integer from public.support_internal_notes n
           where n.support_ticket_id = t.id),
         t.last_message_at,
         t.resolved_at,
         t.closed_at,
         t.created_at
    from public.support_tickets t
    left join public.profiles p on p.id = t.requester_user_id
   where app_private.support_staff_can_read(p_user_id, p_is_aal2)
     and t.assigned_to = p_user_id
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (t.created_at, t.id) < (p_cursor_created_at, p_cursor_id)
     )
   order by t.created_at desc, t.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

comment on function app_private.support_tickets_assigned_to_agent(uuid, boolean, integer, timestamptz, uuid) is
  'One page of the tickets assigned to the calling agent, any status, newest first, over 0028''s support_tickets_assigned index. Scoped to assigned_to = the account the API established, so no argument can show one agent another''s work. Zero rows without support.ticket.read at aal2.';

-- ---------------------------------------------------------------------------------------------------
-- 4. One ticket
-- ---------------------------------------------------------------------------------------------------
-- 0028's agent predicate exactly: the caller holds the read key at aal2, and the ticket is theirs or
-- nobody's. A ticket assigned to another agent, a ticket that does not exist, and a caller who holds
-- nothing all produce the same `not_found` — there is no branch here that could tell them apart.
create or replace function app_private.support_ticket_for_agent(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_ticket_id uuid
) returns table (
  outcome text,
  id uuid,
  reference text,
  subject text,
  category text,
  priority text,
  status text,
  requester_name text,
  is_mine boolean,
  is_assigned boolean,
  message_count integer,
  note_count integer,
  first_response_at timestamptz,
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
  if p_user_id is null or p_ticket_id is null
     or not app_private.support_staff_can_read(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text, null::text,
                        null::text, null::text, null::boolean, null::boolean, null::integer,
                        null::integer, null::timestamptz, null::timestamptz, null::timestamptz,
                        null::timestamptz, null::timestamptz;
    return;
  end if;

  select * into ticket
    from public.support_tickets t
   where t.id = p_ticket_id
     -- 0028's own agent rule: assigned to me, or assigned to nobody.
     and (t.assigned_to = p_user_id or t.assigned_to is null);

  if ticket.id is null then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text, null::text,
                        null::text, null::text, null::boolean, null::boolean, null::integer,
                        null::integer, null::timestamptz, null::timestamptz, null::timestamptz,
                        null::timestamptz, null::timestamptz;
    return;
  end if;

  return query select 'found'::text,
                      ticket.id,
                      ticket.reference,
                      ticket.subject,
                      ticket.category,
                      ticket.priority,
                      ticket.status,
                      (select p.display_name from public.profiles p where p.id = ticket.requester_user_id),
                      -- Who holds it, without saying who anybody is.
                      ticket.assigned_to is not distinct from p_user_id,
                      ticket.assigned_to is not null,
                      ticket.message_count,
                      (select count(*)::integer from public.support_internal_notes n
                        where n.support_ticket_id = ticket.id),
                      ticket.first_response_at,
                      ticket.last_message_at,
                      ticket.resolved_at,
                      ticket.closed_at,
                      ticket.created_at;
end;
$$;

comment on function app_private.support_ticket_for_agent(uuid, boolean, uuid) is
  'One support ticket for an agent who may work on it — 0028''s own agent predicate, for a caller the connection cannot see. A ticket held by another agent, one that does not exist and a caller without the read key at aal2 are all not_found. is_mine and is_assigned are derived from the account the API established, so the console knows whether to offer a claim without ever learning who else holds a ticket; assigned_to itself is not returned.';

-- ---------------------------------------------------------------------------------------------------
-- 5. The conversation
-- ---------------------------------------------------------------------------------------------------
-- The same page the requester reads, from the other side: chosen newest-first from the cursor and returned
-- in reading order, over the same total order `(created_at, id)`. `is_own_message` is true for the
-- *agent's* own messages here, which is the one thing that differs — and it is derived, not passed.
create or replace function app_private.support_ticket_messages_for_agent(
  p_user_id uuid,
  p_is_aal2 boolean,
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
         and (t.assigned_to = p_user_id or t.assigned_to is null)
    ) and app_private.support_staff_can_read(p_user_id, p_is_aal2) as may_read
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

comment on function app_private.support_ticket_messages_for_agent(uuid, boolean, uuid, integer, timestamptz, uuid) is
  'One page of a ticket''s conversation for an agent who may work on it, chosen newest-first from the cursor and returned in reading order. Zero rows for a ticket held by another agent, for one that does not exist and for a caller without the read key at aal2. A message carries its role and whether it is the caller''s own; it never carries an author identifier, and an attachment''s object path is not returned.';

-- ---------------------------------------------------------------------------------------------------
-- 6. The internal notes
-- ---------------------------------------------------------------------------------------------------
-- Staff only, by table: `support_internal_notes` has no requester branch in its policy and no requester
-- reader anywhere. 0028 gates it on the **read** key, which is the key this reader asks for.
--
-- A note reports whether it is the caller's own and nothing else about who wrote it: a colleague's account
-- is not this surface's to disclose.
create or replace function app_private.support_ticket_notes_for_agent(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_ticket_id uuid,
  p_limit integer default 20,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  id uuid,
  is_own_note boolean,
  body text,
  created_at timestamptz
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
         and (t.assigned_to = p_user_id or t.assigned_to is null)
    ) and app_private.support_staff_can_read(p_user_id, p_is_aal2) as may_read
  ),
  bounded as (
    select least(greatest(coalesce(p_limit, 20), 1), 51) as row_limit
  ),
  page as (
    select n.id, n.author_user_id, n.body, n.created_at
      from public.support_internal_notes n
     cross join allowed a
     cross join bounded b
     where a.may_read
       and n.support_ticket_id = p_ticket_id
       and (
         p_cursor_created_at is null
         or p_cursor_id is null
         or (n.created_at, n.id) < (p_cursor_created_at, p_cursor_id)
       )
     order by n.created_at desc, n.id desc
     limit (select row_limit from bounded)
  )
  select page.id,
         page.author_user_id is not distinct from p_user_id,
         page.body,
         page.created_at
    from page
   order by page.created_at, page.id;
$$;

comment on function app_private.support_ticket_notes_for_agent(uuid, boolean, uuid, integer, timestamptz, uuid) is
  'One page of a ticket''s internal notes for an agent who may work on it, in reading order. This is the only reader of support_internal_notes in the repository and it is gated on support.ticket.read at aal2, which is the key 0028''s own policy names. A note reports whether it is the caller''s own; it never carries an author identifier.';

-- ---------------------------------------------------------------------------------------------------
-- 7. Reading one attachment back
-- ---------------------------------------------------------------------------------------------------
-- Three agreements in one statement, as 0074's requester reader has: the ticket is one the caller may work
-- on, the attachment hangs off a message *of that ticket*, and the attachment is the one the route named.
-- 0074's reader is scoped to `requester_user_id` and so cannot serve staff at all; this is the minimum
-- staff equivalent, and it returns a location for the API to sign and nothing else.
create or replace function app_private.support_attachment_for_agent(
  p_user_id uuid,
  p_is_aal2 boolean,
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
  if p_user_id is null or p_ticket_id is null or p_attachment_id is null
     or not app_private.support_staff_can_read(p_user_id, p_is_aal2) then
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
     and (t.assigned_to = p_user_id or t.assigned_to is null);

  if v_path is null then
    return query select 'not_found'::text, null::text, null::text, null::text, null::text;
    return;
  end if;

  return query select 'authorized'::text, 'support-attachments'::text, v_path, v_content_type, v_filename;
end;
$$;

comment on function app_private.support_attachment_for_agent(uuid, boolean, uuid, uuid) is
  'The location of one attachment on a ticket the calling agent may work on, for the API to sign a short-lived read of. The attachment, its message''s ticket and the ticket in the route must all agree, and the caller must hold support.ticket.read at aal2, so an identifier cannot be spent against another agent''s ticket. It returns the path to the API, never to a browser. Writes nothing.';

-- ---------------------------------------------------------------------------------------------------
-- 8. Claiming a ticket
-- ---------------------------------------------------------------------------------------------------
-- `assign_support_ticket` performs no authorization of its own — it is a definer function whose caller is
-- trusted to have established one — so this wrapper is where `support.ticket.manage` at aal2 is required.
--
-- **It assigns the caller to the ticket and takes no agent parameter.** There is nothing here through which
-- one agent could be assigned by another, which is also why this console never needs to know who the other
-- agents are. A ticket already held by somebody else is `not_found`, exactly as it is to every reader.
create or replace function app_private.support_ticket_claim_for_agent(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_ticket_id uuid
) returns table (
  outcome text,
  status text,
  is_mine boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  ticket public.support_tickets;
  v_status text;
begin
  if p_user_id is null or p_ticket_id is null
     or not app_private.support_staff_can_manage(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::text, null::boolean;
    return;
  end if;

  -- Locked, so two agents claiming the same queued ticket serialize: the second one sees the first one's
  -- assignment and is refused as not-found, because by then the ticket is not theirs to see.
  select * into ticket
    from public.support_tickets t
   where t.id = p_ticket_id
     and (t.assigned_to = p_user_id or t.assigned_to is null)
   for update;

  if ticket.id is null then
    return query select 'not_found'::text, null::text, null::boolean;
    return;
  end if;
  if ticket.status = 'closed' then
    return query select 'conflict'::text, null::text, null::boolean;
    return;
  end if;

  begin
    -- 0028's writer, unchanged. It moves `open` to `pending_agent`, bumps the membership version, writes
    -- the `assigned` event and publishes the membership outbox event — none of which is repeated here. A
    -- second claim by the same agent returns without writing, which is its own C10 behaviour.
    perform app_private.assign_support_ticket(p_ticket_id, p_user_id);
  exception
    when insufficient_privilege or check_violation or restrict_violation then
      return query select 'conflict'::text, null::text, null::boolean;
      return;
  end;

  select t.status into v_status from public.support_tickets t where t.id = p_ticket_id;
  return query select 'assigned'::text, v_status, true;
end;
$$;

comment on function app_private.support_ticket_claim_for_agent(uuid, boolean, uuid) is
  'Assigns the calling agent to a ticket that is theirs or nobody''s, by calling 0028''s assign_support_ticket unchanged. Requires support.ticket.manage at aal2. There is no agent parameter, so nobody can be assigned by anybody else; a ticket held by another agent is not_found and a closed one is a conflict. The status move, the membership version, the event and the outbox event are all the writer''s.';

-- ---------------------------------------------------------------------------------------------------
-- 9. Releasing a ticket
-- ---------------------------------------------------------------------------------------------------
-- The writer's own null branch. Only a ticket the caller actually holds can be released — a queued ticket
-- is already released and an unassigned one is refused rather than silently accepted, so the answer always
-- describes something that happened.
create or replace function app_private.support_ticket_release_for_agent(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_ticket_id uuid
) returns table (
  outcome text,
  status text,
  is_mine boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  ticket public.support_tickets;
  v_status text;
begin
  if p_user_id is null or p_ticket_id is null
     or not app_private.support_staff_can_manage(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::text, null::boolean;
    return;
  end if;

  select * into ticket
    from public.support_tickets t
   where t.id = p_ticket_id
     and t.assigned_to = p_user_id
   for update;

  if ticket.id is null then
    return query select 'not_found'::text, null::text, null::boolean;
    return;
  end if;

  begin
    perform app_private.assign_support_ticket(p_ticket_id, null);
  exception
    when insufficient_privilege or check_violation or restrict_violation then
      return query select 'conflict'::text, null::text, null::boolean;
      return;
  end;

  -- The status is unchanged by design: the writer's null branch moves the assignee and nothing else.
  select t.status into v_status from public.support_tickets t where t.id = p_ticket_id;
  return query select 'released'::text, v_status, false;
end;
$$;

comment on function app_private.support_ticket_release_for_agent(uuid, boolean, uuid) is
  'Returns a ticket the calling agent holds to the shared queue, by calling 0028''s assign_support_ticket with a null assignee. Requires support.ticket.manage at aal2, and only a ticket actually assigned to the caller can be released. The status is deliberately unchanged: the writer''s null branch moves the assignee, the membership version and the unassigned event, and nothing else.';

-- ---------------------------------------------------------------------------------------------------
-- 10. Replying to the requester
-- ---------------------------------------------------------------------------------------------------
-- `post_support_message` works the author's role out from the ticket and refuses an agent who may not work
-- on it — so the **assignment** requirement below is 0028's, restated as a refusal rather than left to
-- become an exception. An unassigned ticket cannot be replied to: claim it first.
create or replace function app_private.support_message_post_for_agent(
  p_user_id uuid,
  p_is_aal2 boolean,
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
  if p_user_id is null or p_ticket_id is null
     or not app_private.support_staff_can_manage(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  -- `support_messages_body_length`.
  if p_body is null or length(btrim(p_body)) < 1 or length(btrim(p_body)) > 8000 then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;

  select * into ticket
    from public.support_tickets t
   where t.id = p_ticket_id
     and t.assigned_to = p_user_id
   for update;

  if ticket.id is null then
    -- Not theirs, nobody's, or nothing at all. The console's remedy for the middle case is to claim it,
    -- which it knows from the ticket read rather than from a distinct refusal here.
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
    when insufficient_privilege or check_violation or restrict_violation or foreign_key_violation then
      return query select 'invalid'::text, null::uuid, null::text;
      return;
  end;

  select t.status into v_status from public.support_tickets t where t.id = p_ticket_id;
  return query select 'posted'::text, v_message_id, v_status;
end;
$$;

comment on function app_private.support_message_post_for_agent(uuid, boolean, uuid, text) is
  'Adds one agent message to a ticket assigned to the calling agent, by calling 0028''s post_support_message unchanged. Requires support.ticket.manage at aal2 and an actual assignment — an unassigned ticket is refused, which is 0028''s can_access_support_ticket rule and why claiming is a separate operation. The author role, the counters, the first-response stamp, the status move and the event are all the writer''s.';

-- ---------------------------------------------------------------------------------------------------
-- 11. Writing an internal note
-- ---------------------------------------------------------------------------------------------------
-- The same assignment requirement, for the same reason: `add_support_internal_note` calls
-- `can_access_support_ticket` too, and refuses the requester explicitly on top of it.
create or replace function app_private.support_note_add_for_agent(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_ticket_id uuid,
  p_body text
) returns table (
  outcome text,
  note_id uuid,
  note_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  ticket public.support_tickets;
  v_note_id uuid;
begin
  if p_user_id is null or p_ticket_id is null
     or not app_private.support_staff_can_manage(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::uuid, null::integer;
    return;
  end if;
  -- `support_internal_notes_body_length`.
  if p_body is null or length(btrim(p_body)) < 1 or length(btrim(p_body)) > 8000 then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;

  select * into ticket
    from public.support_tickets t
   where t.id = p_ticket_id
     and t.assigned_to = p_user_id
   for update;

  if ticket.id is null then
    return query select 'not_found'::text, null::uuid, null::integer;
    return;
  end if;
  -- A closed ticket takes no further note, for the same reason it takes no further message: nothing is
  -- being worked on any more. 0028 does not refuse this itself, so it is refused here rather than allowed
  -- to accumulate notes on finished work.
  if ticket.status = 'closed' then
    return query select 'conflict'::text, null::uuid, null::integer;
    return;
  end if;

  begin
    v_note_id := app_private.add_support_internal_note(p_ticket_id, p_user_id, btrim(p_body));
  exception
    when insufficient_privilege or check_violation or restrict_violation or foreign_key_violation then
      return query select 'invalid'::text, null::uuid, null::integer;
      return;
  end;

  return query select 'added'::text,
                      v_note_id,
                      (select count(*)::integer from public.support_internal_notes n
                        where n.support_ticket_id = p_ticket_id);
end;
$$;

comment on function app_private.support_note_add_for_agent(uuid, boolean, uuid, text) is
  'Writes one internal note on a ticket assigned to the calling agent, by calling 0028''s add_support_internal_note unchanged. Requires support.ticket.manage at aal2 and an actual assignment. The note lands in the staff-only table, which has no requester read path anywhere; the note_added event is the writer''s.';

-- ---------------------------------------------------------------------------------------------------
-- 12. Resolving or closing
-- ---------------------------------------------------------------------------------------------------
-- The one wrapper that takes a status, because 0028's `close_support_ticket` defines **two** agent
-- outcomes and both are the agent's to record: `resolved` stamps `resolved_at` and `closed` stamps
-- `closed_at`, and the schema's own constraint contemplates the first becoming the second. The value is
-- checked against those two literals before the call, so nothing else can reach the writer — and
-- `pending_agent`, `pending_requester` and `open` are not assignable by anything here.
create or replace function app_private.support_ticket_close_for_agent(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_ticket_id uuid,
  p_status text
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
  if p_user_id is null or p_ticket_id is null
     or not app_private.support_staff_can_manage(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::text;
    return;
  end if;
  -- The writer's own two values, and nothing else is expressible here.
  if p_status is null or p_status not in ('resolved', 'closed') then
    return query select 'invalid'::text, null::text;
    return;
  end if;

  select * into ticket
    from public.support_tickets t
   where t.id = p_ticket_id
     and t.assigned_to = p_user_id
   for update;

  if ticket.id is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;
  if ticket.status = 'closed' then
    return query select 'conflict'::text, null::text;
    return;
  end if;
  -- Resolving something already resolved would restamp nothing and publish a second event for no change.
  if ticket.status = 'resolved' and p_status = 'resolved' then
    return query select 'conflict'::text, null::text;
    return;
  end if;

  begin
    v_status := app_private.close_support_ticket(p_ticket_id, p_status, p_user_id);
  exception
    when restrict_violation or invalid_parameter_value or check_violation or insufficient_privilege then
      return query select 'conflict'::text, null::text;
      return;
  end;

  return query select 'closed'::text, v_status;
end;
$$;

comment on function app_private.support_ticket_close_for_agent(uuid, boolean, uuid, text) is
  'Records the agent outcome on a ticket assigned to the calling agent — resolved or closed, and only those two, checked against the literals before 0028''s close_support_ticket is called. Requires support.ticket.manage at aal2 and an actual assignment. A closed ticket is a conflict, and so is resolving an already resolved one; a resolved ticket may still be closed, which is what the table''s own resolved-has-time constraint contemplates. It writes no event of its own.';

-- ---------------------------------------------------------------------------------------------------
-- Least privilege
-- ---------------------------------------------------------------------------------------------------
revoke all on function app_private.support_staff_can_read(uuid, boolean) from public;
revoke all on function app_private.support_staff_can_manage(uuid, boolean) from public;
revoke all on function app_private.support_queue_for_agent(uuid, boolean, integer, timestamptz, uuid) from public;
revoke all on function app_private.support_tickets_assigned_to_agent(uuid, boolean, integer, timestamptz, uuid) from public;
revoke all on function app_private.support_ticket_for_agent(uuid, boolean, uuid) from public;
revoke all on function app_private.support_ticket_messages_for_agent(uuid, boolean, uuid, integer, timestamptz, uuid) from public;
revoke all on function app_private.support_ticket_notes_for_agent(uuid, boolean, uuid, integer, timestamptz, uuid) from public;
revoke all on function app_private.support_attachment_for_agent(uuid, boolean, uuid, uuid) from public;
revoke all on function app_private.support_ticket_claim_for_agent(uuid, boolean, uuid) from public;
revoke all on function app_private.support_ticket_release_for_agent(uuid, boolean, uuid) from public;
revoke all on function app_private.support_message_post_for_agent(uuid, boolean, uuid, text) from public;
revoke all on function app_private.support_note_add_for_agent(uuid, boolean, uuid, text) from public;
revoke all on function app_private.support_ticket_close_for_agent(uuid, boolean, uuid, text) from public;

grant execute on function app_private.support_staff_can_read(uuid, boolean) to app_system;
grant execute on function app_private.support_staff_can_manage(uuid, boolean) to app_system;
grant execute on function app_private.support_queue_for_agent(uuid, boolean, integer, timestamptz, uuid) to app_system;
grant execute on function app_private.support_tickets_assigned_to_agent(uuid, boolean, integer, timestamptz, uuid) to app_system;
grant execute on function app_private.support_ticket_for_agent(uuid, boolean, uuid) to app_system;
grant execute on function app_private.support_ticket_messages_for_agent(uuid, boolean, uuid, integer, timestamptz, uuid) to app_system;
grant execute on function app_private.support_ticket_notes_for_agent(uuid, boolean, uuid, integer, timestamptz, uuid) to app_system;
grant execute on function app_private.support_attachment_for_agent(uuid, boolean, uuid, uuid) to app_system;
grant execute on function app_private.support_ticket_claim_for_agent(uuid, boolean, uuid) to app_system;
grant execute on function app_private.support_ticket_release_for_agent(uuid, boolean, uuid) to app_system;
grant execute on function app_private.support_message_post_for_agent(uuid, boolean, uuid, text) to app_system;
grant execute on function app_private.support_note_add_for_agent(uuid, boolean, uuid, text) to app_system;
grant execute on function app_private.support_ticket_close_for_agent(uuid, boolean, uuid, text) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
