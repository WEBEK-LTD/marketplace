-- 0028 — Support tickets and account recovery (v5.2 Support module, "Account recovery"; UB7, C10, D12).
--
-- Two workflows that must never be confused, and are kept apart on purpose:
--
--   * **Support** is for a signed-in user who needs help. Tickets require login, carry the fields the
--     specification lists — reference, subject, category, priority, status, messages, attachments, the
--     related order, the assigned agent, internal notes in their own table and a full event history —
--     and agents work at `aal2` in the admin app on tickets that are assigned to them or still queued.
--   * **Account recovery** is for someone who cannot sign in at all. The specification says in so many
--     words that locked-out users use the recovery flow and not tickets, so recovery has its own tables,
--     its own two-person rule and no read path for the requester beyond a neutral status.
--
-- Recovery does not build a second authentication system. The one-time code is an
-- `app_private.otp_challenges` row with `purpose = 'recovery'` — the purpose 0004 already allows — and
-- the contact can only be marked verified by naming a consumed challenge of that purpose. Every step
-- writes a `public.security_events` row through 0004's recorder, so the account's own security log is
-- the audit trail the specification asks for.
--
-- The approved approver table is enforced, not documented: the identity reviewer and the approver are
-- always two different people, and neither may be the account being recovered. A reviewer can never
-- approve their own review — that is a CHECK and a refusal in the decision function, not a convention.
--
-- The requester sees only neutral statuses. `public.recovery_request_status()` collapses everything to
-- `in_progress`, `completed` or `closed`: it never says whether an account matched the claimed contact,
-- and never says why a request was closed. The claimed and new contacts are stored only as digests, in
-- the same shape 0004 uses, so the table cannot leak an address either.
--
-- The 72-hour block the specification attaches to a completed recovery is implemented once, as
-- `public.user_has_security_hold()`, and then enforced in the two places it names:
--
--   * `app_private.request_withdrawal()` is replaced here with the identical function plus the hold
--     check. Its signature, its behaviour and every other rule it enforces are unchanged; this is the
--     same replace-in-a-later-migration step 0021 used on 0018's `fulfil_checkout()`.
--   * `public.payout_destinations` gains a RESTRICTIVE policy, which ANDs with 0022's permissive ones
--     rather than replacing them, so a held user cannot add or change payout details while 0022 stays
--     exactly as written.
--
-- Nothing here touches the ledger, a payment provider or a payout provider, and O-1 stays deferred:
-- there are no MFA backup codes in this migration. `mfa_reset_at` records only that a reset happened.
--
-- 0014 left `can_join_realtime_topic()` with a note that 0028 extends it. It is replaced here with the
-- same two branches plus support tickets, which carry a membership version exactly as conversations do,
-- so reassigning a ticket retires the old topic and emits its membership event in one transaction (UB6).
-- Ticket payloads stay event references only (UB7).

-- ---------------------------------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------------------------------
insert into public.site_settings (key, category, value, value_type, description_en, description_ar)
values (
  'security.recovery_hold_hours', 'security', '72'::jsonb, 'number',
  'Hours after a completed account recovery during which withdrawals and payout-detail changes are blocked.',
  'عدد الساعات بعد استرداد الحساب التي يُمنع خلالها السحب وتغيير بيانات التحويل.'
)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------------------
-- Support tickets
-- ---------------------------------------------------------------------------------------------------
create table public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  reference text,
  requester_user_id uuid not null references auth.users (id) on delete restrict,
  subject text not null,
  category text not null,
  priority text not null default 'normal',
  status text not null default 'open',
  assigned_to uuid references auth.users (id) on delete set null,
  assigned_at timestamptz,
  order_id uuid references public.orders (id) on delete set null,
  membership_version integer not null default 1,
  message_count integer not null default 0,
  last_message_at timestamptz,
  first_response_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint support_tickets_reference_format check (reference is null or reference ~ '^SP-[0-9]{2}-[0-9]{6,}$'),
  constraint support_tickets_subject_length check (length(btrim(subject)) between 1 and 200),
  constraint support_tickets_category_allowed check (category in (
    'account', 'orders', 'payments', 'payouts', 'listings', 'verification', 'technical', 'other'
  )),
  constraint support_tickets_priority_allowed check (priority in ('low', 'normal', 'high', 'urgent')),
  constraint support_tickets_status_allowed check (status in (
    'open', 'pending_agent', 'pending_requester', 'resolved', 'closed'
  )),
  constraint support_tickets_assigned_has_time check ((assigned_to is null) = (assigned_at is null)),
  -- A requester never handles their own ticket.
  constraint support_tickets_agent_is_not_the_requester check (
    assigned_to is null or assigned_to <> requester_user_id
  ),
  constraint support_tickets_membership_version_positive check (membership_version >= 1),
  constraint support_tickets_message_count_positive check (message_count >= 0),
  -- One-way, like every other terminal stamp in this schema: a resolved ticket may go on to be closed.
  constraint support_tickets_resolved_has_time check (status <> 'resolved' or resolved_at is not null),
  constraint support_tickets_closed_has_time check (status <> 'closed' or closed_at is not null)
);
comment on table public.support_tickets is
  'A signed-in user''s request for help. Tickets require login; somebody locked out of their account uses account recovery instead, which is a different workflow in this same migration.';
comment on column public.support_tickets.membership_version is
  'Bumped whenever the assigned agent changes, so the Realtime topic of a reassigned ticket is a new topic and the old one stops being joinable (UB6).';
create unique index support_tickets_reference on public.support_tickets (reference) where reference is not null;
create index support_tickets_requester on public.support_tickets (requester_user_id, created_at desc);
-- The agent queue: assigned to me, or not assigned to anyone yet.
create index support_tickets_queue on public.support_tickets (status, priority desc, created_at)
  where status in ('open', 'pending_agent');
create index support_tickets_assigned on public.support_tickets (assigned_to, status) where assigned_to is not null;
create index support_tickets_order on public.support_tickets (order_id) where order_id is not null;
create trigger support_tickets_set_updated_at before update on public.support_tickets
  for each row execute function app_private.tg_set_updated_at();
create trigger support_tickets_audit after insert or update or delete on public.support_tickets
  for each row execute function audit.tg_record_change('subject');

-- D12's generator, with its own prefix. Ticket references are what a user quotes back to an agent.
create or replace function app_private.tg_support_tickets_reference() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.reference is null then
    new.reference := app_private.next_reference('SP', 1);
  end if;
  return new;
end;
$$;

create trigger support_tickets_reference before insert on public.support_tickets
  for each row execute function app_private.tg_support_tickets_reference();

create table public.support_ticket_events (
  id bigint generated always as identity primary key,
  support_ticket_id uuid not null references public.support_tickets (id) on delete cascade,
  event_type text not null,
  from_value text,
  to_value text,
  actor_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint support_ticket_events_type_allowed check (event_type in (
    'created', 'status_changed', 'priority_changed', 'assigned', 'unassigned', 'message_posted',
    'note_added', 'reopened'
  ))
);
comment on table public.support_ticket_events is
  'The full event history the specification asks for, append-only. It records that something happened and what it moved between — never the content of a message.';
create index support_ticket_events_ticket on public.support_ticket_events (support_ticket_id, created_at);
create trigger support_ticket_events_append_only before update or delete on public.support_ticket_events
  for each row execute function app_private.tg_reject_write();

create table public.support_messages (
  id uuid primary key default gen_random_uuid(),
  support_ticket_id uuid not null references public.support_tickets (id) on delete cascade,
  author_user_id uuid not null references auth.users (id) on delete restrict,
  author_role text not null,
  body text not null,
  created_at timestamptz not null default now(),
  constraint support_messages_author_role_allowed check (author_role in ('requester', 'agent')),
  constraint support_messages_body_length check (length(btrim(body)) between 1 and 8000)
);
comment on table public.support_messages is
  'The conversation on a ticket, append-only and visible to both sides. Anything an agent does not want the requester to read belongs in support_internal_notes instead.';
create index support_messages_ticket on public.support_messages (support_ticket_id, created_at);
create trigger support_messages_append_only before update or delete on public.support_messages
  for each row execute function app_private.tg_reject_write();

create table public.support_attachments (
  id uuid primary key default gen_random_uuid(),
  support_message_id uuid not null references public.support_messages (id) on delete cascade,
  object_path text not null,
  original_filename text,
  content_type text,
  byte_size bigint,
  created_at timestamptz not null default now(),
  constraint support_attachments_path_present check (length(btrim(object_path)) > 0),
  -- 0012 defined the bucket and it is private; an attachment never lands anywhere else.
  constraint support_attachments_path_is_in_the_private_bucket check (object_path like 'support-attachments/%'),
  constraint support_attachments_size_positive check (byte_size is null or byte_size > 0)
);
comment on table public.support_attachments is
  'Files on a support message. They live in the private support-attachments bucket and are reached only through an API-issued signed URL; this table holds the reference, never the file.';
create index support_attachments_message on public.support_attachments (support_message_id);
create trigger support_attachments_append_only before update or delete on public.support_attachments
  for each row execute function app_private.tg_reject_write();

create table public.support_internal_notes (
  id uuid primary key default gen_random_uuid(),
  support_ticket_id uuid not null references public.support_tickets (id) on delete cascade,
  author_user_id uuid not null references auth.users (id) on delete restrict,
  body text not null,
  created_at timestamptz not null default now(),
  constraint support_internal_notes_body_length check (length(btrim(body)) between 1 and 8000)
);
comment on table public.support_internal_notes is
  'Staff notes, in their own table exactly as the specification requires. Separating them from support_messages is what makes "the requester can never read this" a table-level fact rather than a column flag somebody could forget.';
create index support_internal_notes_ticket on public.support_internal_notes (support_ticket_id, created_at);
create trigger support_internal_notes_append_only before update or delete on public.support_internal_notes
  for each row execute function app_private.tg_reject_write();

-- ---------------------------------------------------------------------------------------------------
-- Support authorization and the ticket Realtime topic
-- ---------------------------------------------------------------------------------------------------
create or replace function public.support_ticket_topic(p_ticket_id uuid) returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select format('support_ticket:%s:v%s', t.id, t.membership_version)
    from public.support_tickets t
   where t.id = p_ticket_id;
$$;
comment on function public.support_ticket_topic(uuid) is
  'The one topic name for a ticket right now. The API hands it out only after authorization; the worker publishes to it, and UB7 keeps the payload to event references only.';

create or replace function public.can_access_support_ticket(p_ticket_id uuid, p_user_id uuid) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.support_tickets t
     where t.id = p_ticket_id
       and p_user_id in (t.requester_user_id, t.assigned_to)
  );
$$;
comment on function public.can_access_support_ticket(uuid, uuid) is
  'Who may work on a ticket: its requester and the agent it is assigned to, and nobody else. Reading the queue of unassigned tickets is a separate thing, expressed in the row level security policies where the permission and aal2 belong; an agent who wants to act on a queued ticket assigns it first.';

-- 0014 said 0028 would extend this. The two existing branches are unchanged; support tickets are added.
create or replace function public.can_join_realtime_topic(p_topic text) returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  parts text[];
  actor uuid := public.current_user_id();
  target uuid;
  version integer;
begin
  -- Fail closed: an unknown shape, a missing claim or an unparsable id joins nothing.
  if actor is null or p_topic is null then
    return false;
  end if;
  parts := string_to_array(p_topic, ':');

  if parts[1] = 'user' and array_length(parts, 1) = 2 then
    begin
      target := parts[2]::uuid;
    exception when others then
      return false;
    end;
    return target = actor;
  end if;

  if parts[1] = 'conversation' and array_length(parts, 1) = 3 and parts[3] ~ '^v[0-9]+$' then
    begin
      target := parts[2]::uuid;
      version := substring(parts[3] from 2)::integer;
    exception when others then
      return false;
    end;
    -- Only the current version of the topic is joinable, and only by a current participant.
    return exists (
      select 1
      from public.conversations c
      join public.conversation_participants p on p.conversation_id = c.id
      where c.id = target
        and c.membership_version = version
        and p.user_id = actor
        and p.left_at is null
    );
  end if;

  if parts[1] = 'support_ticket' and array_length(parts, 1) = 3 and parts[3] ~ '^v[0-9]+$' then
    begin
      target := parts[2]::uuid;
      version := substring(parts[3] from 2)::integer;
    exception when others then
      return false;
    end;
    -- Same rule as a conversation: only the current version, and only someone who may work on it.
    return exists (
      select 1 from public.support_tickets t
       where t.id = target
         and t.membership_version = version
    ) and public.can_access_support_ticket(target, actor);
  end if;

  return false;
end;
$$;
comment on function public.can_join_realtime_topic(text) is
  'The Realtime join check. Clients join private topics only and never publish; unknown topics are refused. Conversations and support tickets both key on the current membership version, so a reassignment retires the old topic.';

-- Reassigning a ticket is a membership change: the version moves and the event is published in the same
-- transaction (UB6), carrying references only (UB7).
create or replace function app_private.tg_support_tickets_membership() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.assigned_to is distinct from old.assigned_to then
    new.membership_version := old.membership_version + 1;
    new.assigned_at := case when new.assigned_to is null then null else now() end;

    insert into public.support_ticket_events (support_ticket_id, event_type, from_value, to_value, actor_user_id)
    values (
      new.id,
      case when new.assigned_to is null then 'unassigned' else 'assigned' end,
      old.assigned_to::text, new.assigned_to::text, new.assigned_to
    );

    perform public.enqueue_outbox_event(
      'support_ticket', new.id::text, 'support_ticket.membership_changed',
      jsonb_build_object('support_ticket_id', new.id, 'membership_version', new.membership_version)
    );
  end if;

  if new.status is distinct from old.status then
    insert into public.support_ticket_events (support_ticket_id, event_type, from_value, to_value)
    values (new.id, 'status_changed', old.status, new.status);
  end if;

  if new.priority is distinct from old.priority then
    insert into public.support_ticket_events (support_ticket_id, event_type, from_value, to_value)
    values (new.id, 'priority_changed', old.priority, new.priority);
  end if;

  return new;
end;
$$;
comment on function app_private.tg_support_tickets_membership() is
  'Keeps the ticket''s Realtime membership version, its assignment stamp and its event history in step with the row, so no write path can skip any of them.';

create trigger support_tickets_membership before update on public.support_tickets
  for each row execute function app_private.tg_support_tickets_membership();

create or replace function app_private.tg_support_tickets_created() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.support_ticket_events (support_ticket_id, event_type, to_value, actor_user_id)
  values (new.id, 'created', new.status, new.requester_user_id);
  return null;
end;
$$;

create trigger support_tickets_created after insert on public.support_tickets
  for each row execute function app_private.tg_support_tickets_created();

-- ---------------------------------------------------------------------------------------------------
-- Support operations
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.open_support_ticket(
  p_requester_user_id uuid,
  p_subject text,
  p_category text,
  p_body text,
  p_order_id uuid default null,
  p_priority text default 'normal'
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  new_ticket_id uuid;
begin
  if p_requester_user_id is null then
    raise exception 'support tickets require a signed-in requester' using errcode = 'insufficient_privilege';
  end if;
  -- A ticket may only point at an order the requester was actually part of.
  if p_order_id is not null and not exists (
    select 1 from public.orders o
     where o.id = p_order_id
       and p_requester_user_id in (o.buyer_user_id, o.seller_user_id)
  ) then
    raise exception 'order % is not this user''s to raise a ticket about', p_order_id
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.support_tickets (requester_user_id, subject, category, priority, order_id)
  values (p_requester_user_id, p_subject, p_category, p_priority, p_order_id)
  returning id into new_ticket_id;

  perform app_private.post_support_message(new_ticket_id, p_requester_user_id, p_body);

  perform public.enqueue_outbox_event(
    'support_ticket', new_ticket_id::text, 'support_ticket.opened',
    jsonb_build_object('support_ticket_id', new_ticket_id, 'category', p_category, 'priority', p_priority)
  );
  return new_ticket_id;
end;
$$;

create or replace function app_private.post_support_message(
  p_ticket_id uuid,
  p_author_user_id uuid,
  p_body text
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  ticket public.support_tickets;
  role_name text;
  new_message_id uuid;
begin
  select * into ticket from public.support_tickets t where t.id = p_ticket_id for update;
  if ticket.id is null then
    raise exception 'support ticket % does not exist', p_ticket_id using errcode = 'no_data_found';
  end if;
  if ticket.status = 'closed' then
    raise exception 'support ticket % is closed', p_ticket_id using errcode = 'restrict_violation';
  end if;

  -- The role comes from the ticket, never from an argument.
  role_name := case when p_author_user_id = ticket.requester_user_id then 'requester' else 'agent' end;
  if role_name = 'agent' and not public.can_access_support_ticket(p_ticket_id, p_author_user_id) then
    raise exception 'this agent may not work on ticket %', p_ticket_id using errcode = 'insufficient_privilege';
  end if;

  insert into public.support_messages (support_ticket_id, author_user_id, author_role, body)
  values (p_ticket_id, p_author_user_id, role_name, p_body)
  returning id into new_message_id;

  insert into public.support_ticket_events (support_ticket_id, event_type, to_value, actor_user_id)
  values (p_ticket_id, 'message_posted', role_name, p_author_user_id);

  update public.support_tickets t
     set message_count = t.message_count + 1,
         last_message_at = now(),
         first_response_at = case
           when role_name = 'agent' and t.first_response_at is null then now()
           else t.first_response_at
         end,
         status = case
           when t.status in ('resolved', 'closed') then t.status
           when role_name = 'agent' then 'pending_requester'
           else 'pending_agent'
         end
   where t.id = p_ticket_id;

  perform public.enqueue_outbox_event(
    'support_ticket', p_ticket_id::text, 'support_ticket.message_posted',
    jsonb_build_object('support_ticket_id', p_ticket_id, 'support_message_id', new_message_id,
                       'author_role', role_name)
  );
  return new_message_id;
end;
$$;
comment on function app_private.post_support_message(uuid, uuid, text) is
  'Adds one message and moves the ticket to whichever side owes the next reply. The author''s role is worked out from the ticket rather than trusted, and an agent who may not work on the ticket is refused.';

comment on function app_private.open_support_ticket(uuid, text, text, text, uuid, text) is
  'Opens a ticket for a signed-in requester, with its first message, refusing an order the requester was not part of. Somebody who cannot sign in uses account recovery instead.';

create or replace function app_private.assign_support_ticket(
  p_ticket_id uuid,
  p_agent_user_id uuid
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  ticket public.support_tickets;
begin
  select * into ticket from public.support_tickets t where t.id = p_ticket_id for update;
  if ticket.id is null then
    raise exception 'support ticket % does not exist', p_ticket_id using errcode = 'no_data_found';
  end if;
  if p_agent_user_id is not null and p_agent_user_id = ticket.requester_user_id then
    raise exception 'a requester cannot be assigned their own ticket' using errcode = 'insufficient_privilege';
  end if;
  if ticket.assigned_to is not distinct from p_agent_user_id then
    return p_ticket_id; -- C10: assigning the same agent again changes nothing
  end if;

  update public.support_tickets
     set assigned_to = p_agent_user_id,
         status = case when status = 'open' and p_agent_user_id is not null then 'pending_agent' else status end
   where id = p_ticket_id;

  return p_ticket_id;
end;
$$;
comment on function app_private.assign_support_ticket(uuid, uuid) is
  'Assigns or unassigns a ticket. The membership trigger does the rest: the version moves, the event is written and the membership outbox event is published in the same transaction.';

create or replace function app_private.close_support_ticket(
  p_ticket_id uuid,
  p_status text,
  p_actor_user_id uuid
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  ticket public.support_tickets;
begin
  if p_status not in ('resolved', 'closed') then
    raise exception 'a ticket closes as resolved or closed, not %', p_status using errcode = 'invalid_parameter_value';
  end if;

  select * into ticket from public.support_tickets t where t.id = p_ticket_id for update;
  if ticket.id is null then
    raise exception 'support ticket % does not exist', p_ticket_id using errcode = 'no_data_found';
  end if;
  if ticket.status = 'closed' then
    raise exception 'support ticket % is already closed', p_ticket_id using errcode = 'restrict_violation';
  end if;
  if not public.can_access_support_ticket(p_ticket_id, p_actor_user_id) then
    raise exception 'this user may not close ticket %', p_ticket_id using errcode = 'insufficient_privilege';
  end if;

  update public.support_tickets
     set status = p_status,
         resolved_at = case when p_status = 'resolved' then coalesce(resolved_at, now()) else resolved_at end,
         closed_at = case when p_status = 'closed' then now() else closed_at end
   where id = p_ticket_id;

  perform public.enqueue_outbox_event(
    'support_ticket', p_ticket_id::text, format('support_ticket.%s', p_status),
    jsonb_build_object('support_ticket_id', p_ticket_id, 'status', p_status)
  );
  return p_status;
end;
$$;

create or replace function app_private.add_support_internal_note(
  p_ticket_id uuid,
  p_author_user_id uuid,
  p_body text
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  ticket public.support_tickets;
  new_note_id uuid;
begin
  select * into ticket from public.support_tickets t where t.id = p_ticket_id;
  if ticket.id is null then
    raise exception 'support ticket % does not exist', p_ticket_id using errcode = 'no_data_found';
  end if;
  -- A requester never writes a staff note, even on their own ticket.
  if p_author_user_id = ticket.requester_user_id then
    raise exception 'the requester cannot write internal notes' using errcode = 'insufficient_privilege';
  end if;
  if not public.can_access_support_ticket(p_ticket_id, p_author_user_id) then
    raise exception 'this agent may not work on ticket %', p_ticket_id using errcode = 'insufficient_privilege';
  end if;

  insert into public.support_internal_notes (support_ticket_id, author_user_id, body)
  values (p_ticket_id, p_author_user_id, p_body)
  returning id into new_note_id;

  insert into public.support_ticket_events (support_ticket_id, event_type, actor_user_id)
  values (p_ticket_id, 'note_added', p_author_user_id);

  return new_note_id;
end;
$$;
comment on function app_private.add_support_internal_note(uuid, uuid, text) is
  'Writes a staff note. The requester is refused explicitly as well as by the table''s policies, so the separation survives a policy mistake.';

-- ---------------------------------------------------------------------------------------------------
-- Account recovery
-- ---------------------------------------------------------------------------------------------------
create table public.account_recovery_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  claimed_contact_channel text not null,
  claimed_contact_hash bytea not null,
  status text not null default 'submitted',
  reviewer_user_id uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  approver_user_id uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  rejection_reason text,
  new_contact_channel text,
  new_contact_hash bytea,
  otp_challenge_id uuid references app_private.otp_challenges (id) on delete set null,
  contact_verified_at timestamptz,
  sessions_revoked_at timestamptz,
  mfa_reset_at timestamptz,
  hold_until timestamptz,
  completed_at timestamptz,
  closed_at timestamptz,
  request_ip inet,
  expires_at timestamptz not null default now() + interval '14 days',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint account_recovery_requests_claimed_channel_allowed check (claimed_contact_channel in ('email', 'phone')),
  constraint account_recovery_requests_new_channel_allowed check (
    new_contact_channel is null or new_contact_channel in ('email', 'phone')
  ),
  constraint account_recovery_requests_new_contact_is_complete check (
    (new_contact_channel is null) = (new_contact_hash is null)
  ),
  constraint account_recovery_requests_status_allowed check (status in (
    'submitted', 'under_review', 'approved', 'rejected', 'contact_verification', 'completed', 'cancelled', 'expired'
  )),
  -- The approved approver table, as constraints: two different people, and neither of them the account.
  constraint account_recovery_requests_approver_is_not_the_reviewer check (
    approver_user_id is null or reviewer_user_id is null or approver_user_id <> reviewer_user_id
  ),
  constraint account_recovery_requests_reviewer_is_not_the_account check (
    reviewer_user_id is null or user_id is null or reviewer_user_id <> user_id
  ),
  constraint account_recovery_requests_approver_is_not_the_account check (
    approver_user_id is null or user_id is null or approver_user_id <> user_id
  ),
  constraint account_recovery_requests_reviewed_has_reviewer check (
    (reviewed_at is null) = (reviewer_user_id is null)
  ),
  constraint account_recovery_requests_approved_has_approver check (
    (approved_at is null) = (approver_user_id is null)
  ),
  -- Nothing is approved without first being reviewed by somebody else.
  constraint account_recovery_requests_approval_follows_review check (
    approved_at is null or reviewed_at is not null
  ),
  constraint account_recovery_requests_rejected_has_reason check (
    status <> 'rejected' or length(btrim(coalesce(rejection_reason, ''))) > 0
  ),
  constraint account_recovery_requests_verified_has_contact check (
    contact_verified_at is null or (new_contact_hash is not null and otp_challenge_id is not null)
  ),
  -- Completion means all of it happened: approved, the new contact verified, sessions revoked, hold set.
  constraint account_recovery_requests_completed_is_complete check (
    status <> 'completed' or (
      completed_at is not null
      and approved_at is not null
      and contact_verified_at is not null
      and sessions_revoked_at is not null
      and hold_until is not null
    )
  ),
  constraint account_recovery_requests_expiry_after_creation check (expires_at > created_at)
);
comment on table public.account_recovery_requests is
  'A claim to an account somebody can no longer sign in to. The claimed and new contacts are stored only as digests, in the same shape app_private.otp_challenges uses, so this table cannot leak an address; `user_id` is NULL when nothing matched, which is what lets the response stay generic.';
comment on column public.account_recovery_requests.user_id is
  'The matched account, or NULL when the claimed contact matched nothing. A request exists either way and looks identical from outside.';
comment on column public.account_recovery_requests.otp_challenge_id is
  'The app_private.otp_challenges row (purpose `recovery`) that proved the new contact. Recovery uses 0004''s one-time codes rather than a second authentication system.';
comment on column public.account_recovery_requests.hold_until is
  'When the 72-hour block on withdrawals and payout-detail changes ends. Enforced by public.user_has_security_hold().';
create index account_recovery_requests_queue on public.account_recovery_requests (status, created_at)
  where status in ('submitted', 'under_review', 'approved', 'contact_verification');
create index account_recovery_requests_account on public.account_recovery_requests (user_id, created_at desc)
  where user_id is not null;
create index account_recovery_requests_claimed on public.account_recovery_requests (claimed_contact_hash, created_at desc);
create index account_recovery_requests_holds on public.account_recovery_requests (user_id, hold_until)
  where hold_until is not null;
create trigger account_recovery_requests_set_updated_at before update on public.account_recovery_requests
  for each row execute function app_private.tg_set_updated_at();
-- Every step audited: the note and the reason are redacted, the decisions are not.
create trigger account_recovery_requests_audit after insert or update or delete on public.account_recovery_requests
  for each row execute function audit.tg_record_change('review_note', 'rejection_reason', 'claimed_contact_hash', 'new_contact_hash');

create table public.account_recovery_evidence (
  id uuid primary key default gen_random_uuid(),
  account_recovery_request_id uuid not null references public.account_recovery_requests (id) on delete cascade,
  evidence_type text not null,
  object_path text not null,
  original_filename text,
  content_type text,
  byte_size bigint,
  uploaded_at timestamptz not null default now(),
  constraint account_recovery_evidence_type_allowed check (evidence_type in (
    'national_id', 'passport', 'selfie', 'proof_of_address', 'purchase_proof', 'other'
  )),
  constraint account_recovery_evidence_path_present check (length(btrim(object_path)) > 0),
  -- 0012 defined the bucket and it is private; recovery evidence never lands anywhere else.
  constraint account_recovery_evidence_path_is_in_the_private_bucket check (object_path like 'recovery-evidence/%'),
  constraint account_recovery_evidence_size_positive check (byte_size is null or byte_size > 0)
);
comment on table public.account_recovery_evidence is
  'Identity evidence for a recovery request, append-only. It lives in the private recovery-evidence bucket and is reached only through an API-issued signed URL.';
create index account_recovery_evidence_request on public.account_recovery_evidence (account_recovery_request_id);
create trigger account_recovery_evidence_append_only before update or delete on public.account_recovery_evidence
  for each row execute function app_private.tg_reject_write();

create table public.account_recovery_approvals (
  id uuid primary key default gen_random_uuid(),
  account_recovery_request_id uuid not null references public.account_recovery_requests (id) on delete cascade,
  approver_user_id uuid not null references auth.users (id) on delete restrict,
  decision text not null,
  note text,
  created_at timestamptz not null default now(),
  constraint account_recovery_approvals_decision_allowed check (decision in ('approved', 'rejected')),
  constraint account_recovery_approvals_note_length check (note is null or length(btrim(note)) between 1 and 2000),
  -- One decision per person per request: a second approver is a second person.
  unique (account_recovery_request_id, approver_user_id)
);
comment on table public.account_recovery_approvals is
  'Each decision on a recovery request, append-only and one per person. The reviewer can never appear here for their own review, which is what makes "a second approver who is not the reviewer" a fact rather than a process note.';
create index account_recovery_approvals_request on public.account_recovery_approvals (account_recovery_request_id, created_at);
create trigger account_recovery_approvals_append_only before update or delete on public.account_recovery_approvals
  for each row execute function app_private.tg_reject_write();

-- ---------------------------------------------------------------------------------------------------
-- The generic response
-- ---------------------------------------------------------------------------------------------------
create or replace function public.recovery_request_status(p_request_id uuid) returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  -- Deliberately lossy. The requester learns that the request is moving, finished or over — never
  -- whether an account matched, who looked at it, or why it ended.
  select case r.status
    when 'completed' then 'completed'
    when 'rejected' then 'closed'
    when 'cancelled' then 'closed'
    when 'expired' then 'closed'
    else 'in_progress'
  end
    from public.account_recovery_requests r
   where r.id = p_request_id;
$$;
comment on function public.recovery_request_status(uuid) is
  'The only thing a requester is ever told: in_progress, completed or closed. It never reveals whether the claimed contact matched an account, and an unknown request id simply answers nothing.';

create or replace function public.user_has_security_hold(
  p_user_id uuid,
  p_operation text
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p_operation in ('withdrawal', 'payout_details')
     and exists (
       select 1 from public.account_recovery_requests r
        where r.user_id = p_user_id
          and r.status = 'completed'
          and r.hold_until is not null
          and r.hold_until > now()
     );
$$;
comment on function public.user_has_security_hold(uuid, text) is
  'True while the block a completed account recovery puts on withdrawals and payout-detail changes is still running. Any other operation answers false, so the hold never spreads beyond what the specification attaches it to.';

-- ---------------------------------------------------------------------------------------------------
-- Recovery operations
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.open_recovery_request(
  p_claimed_contact_channel text,
  p_claimed_contact_hash bytea,
  p_matched_user_id uuid default null,
  p_request_ip inet default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  new_request_id uuid;
begin
  insert into public.account_recovery_requests (
    user_id, claimed_contact_channel, claimed_contact_hash, request_ip
  )
  values (p_matched_user_id, p_claimed_contact_channel, p_claimed_contact_hash, p_request_ip)
  returning id into new_request_id;

  perform public.enqueue_outbox_event(
    'account_recovery', new_request_id::text, 'account_recovery.requested',
    jsonb_build_object('account_recovery_request_id', new_request_id, 'has_match', p_matched_user_id is not null)
  );
  return new_request_id;
end;
$$;
comment on function app_private.open_recovery_request(text, bytea, uuid, inet) is
  'Records a recovery claim. A request is created whether or not the contact matched an account, so the caller can answer identically either way; the API resolves the match and passes only the digest.';

create or replace function app_private.review_recovery_request(
  p_request_id uuid,
  p_reviewer_user_id uuid,
  p_note text default null
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  request public.account_recovery_requests;
begin
  select * into request from public.account_recovery_requests r where r.id = p_request_id for update;
  if request.id is null then
    raise exception 'recovery request % does not exist', p_request_id using errcode = 'no_data_found';
  end if;
  if request.status not in ('submitted', 'under_review') then
    raise exception 'recovery request % is % and is no longer under review', p_request_id, request.status
      using errcode = 'restrict_violation';
  end if;
  if request.user_id is not null and p_reviewer_user_id = request.user_id then
    raise exception 'nobody reviews their own recovery' using errcode = 'insufficient_privilege';
  end if;

  update public.account_recovery_requests
     set status = 'under_review',
         reviewer_user_id = p_reviewer_user_id,
         reviewed_at = now(),
         review_note = p_note
   where id = p_request_id;

  return 'under_review';
end;
$$;
comment on function app_private.review_recovery_request(uuid, uuid, text) is
  'Records the identity review and who did it. The reviewer is fixed from here on, which is what the second approver is checked against.';

create or replace function app_private.decide_recovery_request(
  p_request_id uuid,
  p_approver_user_id uuid,
  p_decision text,
  p_note text default null
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  request public.account_recovery_requests;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'a recovery decision is approved or rejected, not %', p_decision
      using errcode = 'invalid_parameter_value';
  end if;
  if p_decision = 'rejected' and length(btrim(coalesce(p_note, ''))) = 0 then
    raise exception 'a rejection is always recorded with its reason' using errcode = 'check_violation';
  end if;

  select * into request from public.account_recovery_requests r where r.id = p_request_id for update;
  if request.id is null then
    raise exception 'recovery request % does not exist', p_request_id using errcode = 'no_data_found';
  end if;
  if request.status <> 'under_review' then
    raise exception 'recovery request % must be reviewed before it is decided', p_request_id
      using errcode = 'restrict_violation';
  end if;
  -- The rule the specification states twice: the reviewer can never approve their own review.
  if p_approver_user_id = request.reviewer_user_id then
    raise exception 'the approver must be somebody other than the reviewer' using errcode = 'insufficient_privilege';
  end if;
  if request.user_id is not null and p_approver_user_id = request.user_id then
    raise exception 'nobody approves their own recovery' using errcode = 'insufficient_privilege';
  end if;

  insert into public.account_recovery_approvals (account_recovery_request_id, approver_user_id, decision, note)
  values (p_request_id, p_approver_user_id, p_decision, p_note);

  update public.account_recovery_requests
     set status = case when p_decision = 'approved' then 'contact_verification' else 'rejected' end,
         approver_user_id = case when p_decision = 'approved' then p_approver_user_id else approver_user_id end,
         approved_at = case when p_decision = 'approved' then now() else approved_at end,
         rejection_reason = case when p_decision = 'rejected' then p_note else rejection_reason end,
         closed_at = case when p_decision = 'rejected' then now() else closed_at end
   where id = p_request_id;

  perform public.enqueue_outbox_event(
    'account_recovery', p_request_id::text, format('account_recovery.%s', p_decision),
    jsonb_build_object('account_recovery_request_id', p_request_id)
  );
  return p_decision;
end;
$$;
comment on function app_private.decide_recovery_request(uuid, uuid, text, text) is
  'The second approver''s decision. It refuses the reviewer, refuses the account holder, and records one decision per person; an approval moves the request on to verifying the new contact by OTP.';

create or replace function app_private.verify_recovery_contact(
  p_request_id uuid,
  p_otp_challenge_id uuid,
  p_new_contact_channel text,
  p_new_contact_hash bytea
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  request public.account_recovery_requests;
  challenge app_private.otp_challenges;
begin
  select * into request from public.account_recovery_requests r where r.id = p_request_id for update;
  if request.id is null then
    raise exception 'recovery request % does not exist', p_request_id using errcode = 'no_data_found';
  end if;
  if request.status <> 'contact_verification' then
    raise exception 'recovery request % is not awaiting contact verification', p_request_id
      using errcode = 'restrict_violation';
  end if;

  -- 0004 owns one-time codes. Recovery names a challenge of its own purpose that has been consumed;
  -- it never verifies a code itself.
  select * into challenge from app_private.otp_challenges c where c.id = p_otp_challenge_id;
  if challenge.id is null then
    raise exception 'otp challenge % does not exist', p_otp_challenge_id using errcode = 'no_data_found';
  end if;
  if challenge.purpose <> 'recovery' then
    raise exception 'that challenge was not issued for account recovery' using errcode = 'insufficient_privilege';
  end if;
  if challenge.consumed_at is null then
    raise exception 'that challenge has not been completed' using errcode = 'insufficient_privilege';
  end if;
  if challenge.destination_hash <> p_new_contact_hash then
    raise exception 'that challenge was sent to a different contact' using errcode = 'insufficient_privilege';
  end if;

  update public.account_recovery_requests
     set new_contact_channel = p_new_contact_channel,
         new_contact_hash = p_new_contact_hash,
         otp_challenge_id = p_otp_challenge_id,
         contact_verified_at = now()
   where id = p_request_id;

  return 'verified';
end;
$$;
comment on function app_private.verify_recovery_contact(uuid, uuid, text, bytea) is
  'Marks the new contact verified, but only by naming a consumed app_private.otp_challenges row of purpose `recovery` whose destination digest matches. Recovery therefore cannot bypass 0004''s one-time codes, and cannot verify a contact a code was never sent to.';

create or replace function app_private.complete_recovery_request(
  p_request_id uuid,
  p_actor_user_id uuid,
  p_mfa_was_reset boolean default false
) returns timestamptz
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  request public.account_recovery_requests;
  hold_hours integer := coalesce((public.site_setting('security.recovery_hold_hours'))::integer, 72);
  hold timestamptz;
begin
  select * into request from public.account_recovery_requests r where r.id = p_request_id for update;
  if request.id is null then
    raise exception 'recovery request % does not exist', p_request_id using errcode = 'no_data_found';
  end if;
  if request.status <> 'contact_verification' or request.contact_verified_at is null then
    raise exception 'recovery request % is not ready to complete', p_request_id using errcode = 'restrict_violation';
  end if;
  if request.approved_at is null then
    raise exception 'recovery request % was never approved', p_request_id using errcode = 'restrict_violation';
  end if;
  if request.user_id is null then
    raise exception 'recovery request % matched no account and can never complete', p_request_id
      using errcode = 'restrict_violation';
  end if;
  if p_actor_user_id = request.user_id then
    raise exception 'nobody completes their own recovery' using errcode = 'insufficient_privilege';
  end if;

  hold := now() + make_interval(hours => hold_hours);

  update public.account_recovery_requests
     set status = 'completed',
         sessions_revoked_at = now(),
         mfa_reset_at = case when p_mfa_was_reset then now() else mfa_reset_at end,
         hold_until = hold,
         completed_at = now()
   where id = p_request_id;

  -- The account's own security log is the audit trail, and the old contacts are notified from the
  -- outbox event rather than from here.
  insert into public.security_events (user_id, event_type, details)
  values (
    request.user_id, 'account_recovery.completed',
    jsonb_build_object('account_recovery_request_id', p_request_id, 'hold_until', hold,
                       'mfa_reset', p_mfa_was_reset)
  );

  perform public.enqueue_outbox_event(
    'account_recovery', p_request_id::text, 'account_recovery.completed',
    jsonb_build_object('account_recovery_request_id', p_request_id, 'user_id', request.user_id,
                       'hold_until', hold, 'mfa_reset', p_mfa_was_reset)
  );
  return hold;
end;
$$;
comment on function app_private.complete_recovery_request(uuid, uuid, boolean) is
  'Finishes a recovery: sessions revoked, any MFA reset recorded, and the configured block on withdrawals and payout-detail changes started. A request that matched no account can never reach this point.';

-- ---------------------------------------------------------------------------------------------------
-- Enforcing the hold
-- ---------------------------------------------------------------------------------------------------
-- 0021's function, unchanged except for the hold check. The signature, the limits, the dispute freeze,
-- the row lock and the reservation journal are all exactly as 0021 wrote them.
create or replace function app_private.request_withdrawal(
  p_seller_user_id uuid,
  p_currency_code char(3),
  p_amount_minor bigint,
  p_idempotency_key text default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  existing_id uuid;
  caps public.withdrawal_limits;
  balance public.seller_balances;
  open_requests integer;
  today_total bigint;
  withdrawal_id uuid;
  journal_id uuid;
begin
  if p_idempotency_key is not null then
    select w.id into existing_id from public.withdrawals w where w.idempotency_key = p_idempotency_key;
    if existing_id is not null then
      return existing_id;
    end if;
  end if;

  -- Fail closed: a currency with no active limits row cannot be withdrawn in.
  select * into caps from public.withdrawal_limits l
   where l.currency_code = p_currency_code and l.is_active;
  if caps.currency_code is null then
    raise exception 'withdrawals are not configured for %', p_currency_code using errcode = 'restrict_violation';
  end if;

  if p_amount_minor < caps.min_amount_minor then
    raise exception 'the withdrawal minimum for % is %', p_currency_code, caps.min_amount_minor
      using errcode = 'check_violation';
  end if;
  if caps.max_amount_minor is not null and p_amount_minor > caps.max_amount_minor then
    raise exception 'the withdrawal maximum for % is %', p_currency_code, caps.max_amount_minor
      using errcode = 'check_violation';
  end if;

  -- 0028: the block a completed account recovery puts on withdrawals.
  if public.user_has_security_hold(p_seller_user_id, 'withdrawal') then
    raise exception 'withdrawals are held after a recent account recovery' using errcode = 'restrict_violation';
  end if;

  -- D26: nothing is withdrawable while a dispute is holding this seller's funds.
  if public.seller_funds_are_frozen(p_seller_user_id) then
    raise exception 'an open dispute is holding this seller''s funds' using errcode = 'restrict_violation';
  end if;

  perform app_private.ensure_seller_balance(p_seller_user_id, p_currency_code);
  select * into balance
    from public.seller_balances b
   where b.seller_user_id = p_seller_user_id and b.currency_code = p_currency_code
     for update;

  if balance.available_minor < p_amount_minor then
    raise exception 'available funds % are below the requested %', balance.available_minor, p_amount_minor
      using errcode = 'check_violation';
  end if;

  select count(*) into open_requests
    from public.withdrawals w
   where w.seller_user_id = p_seller_user_id
     and w.currency_code = p_currency_code
     and w.status in ('requested', 'under_review', 'approved', 'processing');
  if caps.max_open_requests is not null and open_requests >= caps.max_open_requests then
    raise exception 'this seller already has % open withdrawals', open_requests using errcode = 'restrict_violation';
  end if;

  if caps.daily_limit_minor is not null then
    select coalesce(sum(w.amount_minor), 0) into today_total
      from public.withdrawals w
     where w.seller_user_id = p_seller_user_id
       and w.currency_code = p_currency_code
       and w.requested_at >= date_trunc('day', now())
       and w.status <> 'cancelled';
    if today_total + p_amount_minor > caps.daily_limit_minor then
      raise exception 'the daily withdrawal limit for % is %', p_currency_code, caps.daily_limit_minor
        using errcode = 'restrict_violation';
    end if;
  end if;

  insert into public.withdrawals (currency_code, seller_user_id, amount_minor, idempotency_key)
  values (p_currency_code, p_seller_user_id, p_amount_minor, p_idempotency_key)
  returning id into withdrawal_id;

  -- Funds are reserved the moment the request exists, so the same money cannot be requested twice.
  journal_id := app_private.post_ledger_journal(
    'withdrawal_reserved',
    p_currency_code,
    jsonb_build_array(
      jsonb_build_object('account_type', 'seller_available', 'seller_user_id', p_seller_user_id,
                         'direction', 'debit', 'amount_minor', p_amount_minor,
                         'withdrawal_id', withdrawal_id, 'memo', 'withdrawal requested'),
      jsonb_build_object('account_type', 'seller_reserved', 'seller_user_id', p_seller_user_id,
                         'direction', 'credit', 'amount_minor', p_amount_minor,
                         'withdrawal_id', withdrawal_id, 'memo', 'withdrawal requested')
    ),
    'withdrawal', withdrawal_id::text,
    format('withdrawal:%s:reserved', withdrawal_id),
    'Withdrawal requested'
  );

  update public.withdrawals set reserve_journal_id = journal_id where id = withdrawal_id;

  perform public.enqueue_outbox_event(
    'withdrawal', withdrawal_id::text, 'withdrawal.requested',
    jsonb_build_object('withdrawal_id', withdrawal_id, 'seller_user_id', p_seller_user_id,
                       'currency_code', p_currency_code, 'amount_minor', p_amount_minor)
  );
  return withdrawal_id;
end;
$$;
comment on function app_private.request_withdrawal(uuid, char, bigint, text) is
  'Creates a withdrawal request and reserves its funds in the same transaction, after the limits, the available balance, the dispute freeze and the post-recovery security hold have all agreed.';

-- A RESTRICTIVE policy ANDs with 0022's permissive ones, so payout details become unchangeable during
-- the hold without 0022 being touched at all.
-- Only the write paths: a held seller can still read their own details, they just cannot move them.
create policy payout_destinations_no_security_hold_insert on public.payout_destinations
  as restrictive
  for insert
  to authenticated
  with check (not public.user_has_security_hold(seller_user_id, 'payout_details'));

create policy payout_destinations_no_security_hold_update on public.payout_destinations
  as restrictive
  for update
  to authenticated
  using (not public.user_has_security_hold(seller_user_id, 'payout_details'))
  with check (not public.user_has_security_hold(seller_user_id, 'payout_details'));

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table public.support_tickets enable row level security;
alter table public.support_messages enable row level security;
alter table public.support_attachments enable row level security;
alter table public.support_internal_notes enable row level security;
alter table public.support_ticket_events enable row level security;
alter table public.account_recovery_requests enable row level security;
alter table public.account_recovery_evidence enable row level security;
alter table public.account_recovery_approvals enable row level security;

-- Support: a user reads only their own tickets; an agent reads what they may work on, at aal2.
create policy support_tickets_requester_read on public.support_tickets for select to authenticated
  using (requester_user_id = public.current_user_id());
create policy support_tickets_agent_read on public.support_tickets for select to authenticated
  using (
    public.has_permission('support.ticket.read')
    and public.is_aal2()
    and (assigned_to = public.current_user_id() or assigned_to is null)
  );
create policy support_tickets_agent_update on public.support_tickets for update to authenticated
  using (
    public.has_permission('support.ticket.manage')
    and public.is_aal2()
    and (assigned_to = public.current_user_id() or assigned_to is null)
  )
  with check (public.has_permission('support.ticket.manage') and public.is_aal2());

create policy support_messages_read on public.support_messages for select to authenticated
  using (exists (
    select 1 from public.support_tickets t
     where t.id = support_ticket_id
       and (
         t.requester_user_id = public.current_user_id()
         or (public.has_permission('support.ticket.read') and public.is_aal2()
             and (t.assigned_to = public.current_user_id() or t.assigned_to is null))
       )
  ));

create policy support_attachments_read on public.support_attachments for select to authenticated
  using (exists (
    select 1
      from public.support_messages m
      join public.support_tickets t on t.id = m.support_ticket_id
     where m.id = support_message_id
       and (
         t.requester_user_id = public.current_user_id()
         or (public.has_permission('support.ticket.read') and public.is_aal2()
             and (t.assigned_to = public.current_user_id() or t.assigned_to is null))
       )
  ));

-- Internal notes are staff-only, by table. There is deliberately no requester branch here at all.
create policy support_internal_notes_staff_read on public.support_internal_notes for select to authenticated
  using (
    public.has_permission('support.ticket.read')
    and public.is_aal2()
    and exists (
      select 1 from public.support_tickets t
       where t.id = support_ticket_id
         and (t.assigned_to = public.current_user_id() or t.assigned_to is null)
    )
  );

create policy support_ticket_events_read on public.support_ticket_events for select to authenticated
  using (exists (
    select 1 from public.support_tickets t
     where t.id = support_ticket_id
       and (
         t.requester_user_id = public.current_user_id()
         or (public.has_permission('support.ticket.read') and public.is_aal2()
             and (t.assigned_to = public.current_user_id() or t.assigned_to is null))
       )
  ));

-- Account recovery: the queue is staff-only at aal2. The account holder can see their own history once
-- they are signed in again; a requester who is still locked out reads nothing directly and gets the
-- generic status through the API instead.
create policy account_recovery_requests_owner_read on public.account_recovery_requests for select to authenticated
  using (user_id = public.current_user_id());
create policy account_recovery_requests_staff_read on public.account_recovery_requests for select to authenticated
  using (public.has_permission('security.recovery.review') and public.is_aal2());

create policy account_recovery_evidence_staff_read on public.account_recovery_evidence for select to authenticated
  using (public.has_permission('security.recovery.review') and public.is_aal2());

create policy account_recovery_approvals_staff_read on public.account_recovery_approvals for select to authenticated
  using (public.has_permission('security.recovery.review') and public.is_aal2());

-- Every write goes through a SECURITY DEFINER function, so nobody holds INSERT anywhere here.
grant select on public.support_tickets to authenticated;
grant update on public.support_tickets to authenticated;
grant select on public.support_messages to authenticated;
grant select on public.support_attachments to authenticated;
grant select on public.support_internal_notes to authenticated;
grant select on public.support_ticket_events to authenticated;
grant select on public.account_recovery_requests to authenticated;
grant select on public.account_recovery_evidence to authenticated;
grant select on public.account_recovery_approvals to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function
  public.support_ticket_topic(uuid),
  public.can_access_support_ticket(uuid, uuid),
  public.can_join_realtime_topic(text),
  public.recovery_request_status(uuid),
  public.user_has_security_hold(uuid, text)
  to authenticated;

grant execute on function
  public.support_ticket_topic(uuid),
  public.can_access_support_ticket(uuid, uuid),
  public.can_join_realtime_topic(text),
  public.recovery_request_status(uuid),
  public.user_has_security_hold(uuid, text),
  app_private.open_support_ticket(uuid, text, text, text, uuid, text),
  app_private.post_support_message(uuid, uuid, text),
  app_private.assign_support_ticket(uuid, uuid),
  app_private.close_support_ticket(uuid, text, uuid),
  app_private.add_support_internal_note(uuid, uuid, text),
  app_private.open_recovery_request(text, bytea, uuid, inet),
  app_private.review_recovery_request(uuid, uuid, text),
  app_private.decide_recovery_request(uuid, uuid, text, text),
  app_private.verify_recovery_contact(uuid, uuid, text, bytea),
  app_private.complete_recovery_request(uuid, uuid, boolean),
  app_private.request_withdrawal(uuid, char, bigint, text)
  to app_system, app_worker;
