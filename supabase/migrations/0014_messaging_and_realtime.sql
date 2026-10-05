-- 0014 — Messaging and the Realtime private-topic policies (v5.2 migration plan; UB6, UB7, N3).
--
-- The database is the authoritative record. A message is written here and an outbox event is written in
-- the same transaction; after the commit the worker publishes the Broadcast to the conversation's
-- current membership-versioned topic. Clients never publish: they only join private topics, and they
-- recover missed messages through API cursor catch-up (`messages.seq`).
--
-- UB6 (approved minimum rule): every membership change increments `conversations.membership_version`
-- AND writes a corresponding outbox event in the same database transaction. The topic name carries the
-- version, so a removed participant's topic stops receiving application messages immediately; this
-- shortens the revocation window rather than revoking instantly (N3).
--
-- Topic names are fixed here so the worker, the API and the policy cannot disagree:
--   conversation:<conversation_id>:v<membership_version>   — current participants only, content allowed
--   user:<user_id>                                          — that user only, notification id + display fields
--   ticket:<ticket_id>                                      — added by 0028 (Support); event references only (UB7)
--
-- The join check is a SECURITY DEFINER helper in `public`, so `authenticated` needs no table grants for
-- it and still no access to `app_private`.

-- ---------------------------------------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------------------------------------
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null default 'direct',
  listing_id uuid references public.listings (id) on delete set null,
  listing_title_snapshot text,
  membership_version integer not null default 1,
  created_by uuid not null references auth.users (id) on delete restrict,
  last_message_at timestamptz,
  message_count integer not null default 0,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversations_subject_type_allowed check (subject_type in ('direct', 'listing', 'service_request', 'order')),
  constraint conversations_listing_subject check (subject_type <> 'listing' or listing_id is not null),
  constraint conversations_membership_version_positive check (membership_version >= 1),
  constraint conversations_message_count_positive check (message_count >= 0),
  constraint conversations_listing_snapshot_length check (listing_title_snapshot is null or length(listing_title_snapshot) <= 140)
);
comment on table public.conversations is
  'A conversation and its current membership version. `listing_title_snapshot` keeps the referenced card identifiable after the listing stops being available.';
create index conversations_recent on public.conversations (last_message_at desc nulls last, id);
create index conversations_listing on public.conversations (listing_id) where listing_id is not null;
create trigger conversations_set_updated_at before update on public.conversations
  for each row execute function app_private.tg_set_updated_at();

create table public.conversation_participants (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member',
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  last_read_seq bigint,
  is_muted boolean not null default false,
  primary key (conversation_id, user_id),
  constraint conversation_participants_role_allowed check (role in ('buyer', 'seller', 'member', 'support')),
  constraint conversation_participants_left_after_join check (left_at is null or left_at >= joined_at)
);
comment on table public.conversation_participants is 'Membership. A row with left_at set is history: that user is no longer a current participant.';
create index conversation_participants_by_user on public.conversation_participants (user_id, conversation_id) where left_at is null;

create or replace function public.is_conversation_participant(p_conversation_id uuid, p_user_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.conversation_participants p
    where p.conversation_id = p_conversation_id
      and p.user_id = coalesce(p_user_id, public.current_user_id())
      and p.left_at is null
  );
$$;
comment on function public.is_conversation_participant(uuid, uuid) is 'True while the user is a current participant (a member who left is not).';

-- ---------------------------------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------------------------------
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_user_id uuid references auth.users (id) on delete set null,
  message_type text not null default 'text',
  body text,
  reference_type text,
  reference_id uuid,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  constraint messages_type_allowed check (message_type in ('text', 'system', 'reference')),
  constraint messages_reference_type_allowed check (reference_type is null or reference_type in ('listing', 'offer', 'service_request', 'service_quote', 'order')),
  constraint messages_reference_is_complete check ((reference_type is null) = (reference_id is null)),
  constraint messages_reference_type_needs_reference check (message_type <> 'reference' or reference_type is not null),
  constraint messages_text_has_body check (message_type <> 'text' or length(btrim(coalesce(body, ''))) between 1 and 5000),
  constraint messages_sender_required check (message_type = 'system' or sender_user_id is not null)
);
comment on table public.messages is
  'The authoritative message record. `seq` is the catch-up cursor; `id` is what clients de-duplicate on. References are ids resolved at read time.';
create unique index messages_seq on public.messages (seq);
create index messages_conversation_cursor on public.messages (conversation_id, seq);
create index messages_sender on public.messages (sender_user_id, created_at desc);

create table public.message_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages (id) on delete cascade,
  object_path text not null,
  content_type text not null,
  byte_size bigint not null,
  width integer,
  height integer,
  created_at timestamptz not null default now(),
  constraint message_attachments_path_present check (length(btrim(object_path)) > 0),
  constraint message_attachments_size_positive check (byte_size > 0),
  constraint message_attachments_dimensions_positive check ((width is null or width > 0) and (height is null or height > 0))
);
comment on table public.message_attachments is
  'Attachments live in the private message-attachments bucket and are reached only through short-lived API-signed URLs (C15).';
create unique index message_attachments_object_path on public.message_attachments (object_path);
create index message_attachments_message on public.message_attachments (message_id);

-- ---------------------------------------------------------------------------------------------------
-- Membership version and the outbox events (UB6)
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.tg_conversation_membership_changed() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target_conversation uuid := coalesce(new.conversation_id, old.conversation_id);
  target_user uuid := coalesce(new.user_id, old.user_id);
  changed boolean := tg_op <> 'UPDATE' or (new.left_at is distinct from old.left_at);
  new_version integer;
begin
  if not changed then
    return null;
  end if;
  update public.conversations
     set membership_version = membership_version + 1
   where id = target_conversation
  returning membership_version into new_version;

  -- The increment and its event share this transaction, so a client can never learn of the change
  -- without the version having moved, or the other way round.
  perform public.enqueue_outbox_event(
    'conversation', target_conversation::text, 'conversation.membership_changed',
    jsonb_build_object(
      'conversation_id', target_conversation,
      'user_id', target_user,
      'membership_version', new_version,
      'change', lower(tg_op)
    )
  );
  return null;
end;
$$;

create trigger conversation_participants_membership_changed
  after insert or update of left_at or delete on public.conversation_participants
  for each row execute function app_private.tg_conversation_membership_changed();

create or replace function app_private.tg_messages_created() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.conversations
     set last_message_at = new.created_at,
         message_count = message_count + 1
   where id = new.conversation_id;

  perform public.enqueue_outbox_event(
    'conversation', new.conversation_id::text, 'conversation.message_created',
    jsonb_build_object('conversation_id', new.conversation_id, 'message_id', new.id, 'seq', new.seq)
  );
  return null;
end;
$$;
comment on function app_private.tg_messages_created() is
  'Writes the outbox event in the same transaction as the message, so the worker publishes exactly what committed.';

create trigger messages_created after insert on public.messages
  for each row execute function app_private.tg_messages_created();

-- A blocked pair cannot keep talking.
create or replace function app_private.tg_messages_block_rule() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  other_party uuid;
begin
  if new.sender_user_id is null then
    return new;
  end if;
  for other_party in
    select p.user_id from public.conversation_participants p
     where p.conversation_id = new.conversation_id and p.left_at is null and p.user_id <> new.sender_user_id
  loop
    if public.is_blocked_between(new.sender_user_id, other_party) then
      raise exception 'the conversation is blocked between these users' using errcode = 'insufficient_privilege';
    end if;
  end loop;
  return new;
end;
$$;

create trigger messages_block_rule before insert on public.messages
  for each row execute function app_private.tg_messages_block_rule();

-- ---------------------------------------------------------------------------------------------------
-- Realtime topics
-- ---------------------------------------------------------------------------------------------------
create or replace function public.conversation_topic(p_conversation_id uuid) returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select format('conversation:%s:v%s', c.id, c.membership_version)
    from public.conversations c
   where c.id = p_conversation_id;
$$;
comment on function public.conversation_topic(uuid) is
  'The one topic name for a conversation right now. The API hands it out only after authorization; the worker publishes to it.';

create or replace function public.user_topic(p_user_id uuid) returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select format('user:%s', p_user_id);
$$;

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

  return false;
end;
$$;
comment on function public.can_join_realtime_topic(text) is
  'The Realtime join check. Clients join private topics only and never publish; unknown topics are refused (0028 extends this with support tickets).';

-- Supabase Realtime creates and owns realtime.messages, exactly as Supabase Storage owns the storage
-- tables (0012). The migrating role is not that owner, so `alter table realtime.messages …` is
-- owner-only and unreachable here, and the table's ACL belongs to the provider: a REVOKE or GRANT run
-- by this role touches only what this role is entitled to change and cannot be relied on. This
-- migration therefore verifies the provider-managed state it depends on and establishes only what it
-- can actually establish — the private-topic policy.
--
-- The boundary that holds: row level security is on (verified), the one policy is SELECT-only for
-- `authenticated` and gated by public.can_join_realtime_topic(topic), and there is no INSERT policy, so
-- a client can receive on a topic it may join and can publish nothing. The worker publishes with server
-- credentials, outside this path.

-- 1. Provider-managed state: the table exists and row level security is on. Verified, not set.
do $$
declare
  enabled boolean;
begin
  select c.relrowsecurity into enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'realtime' and c.relname = 'messages';
  if enabled is null then
    raise exception 'Supabase Realtime is not installed in this database'
      using hint = 'Migration 0014 defines the private-topic policies on realtime.messages.';
  end if;
  if not enabled then
    raise exception 'row level security is not enabled on realtime.messages'
      using hint = 'Supabase Realtime enables it on the mailbox, and it is what confines a subscriber to the topics can_join_realtime_topic() allows. The migration role does not own realtime.messages and cannot enable it.';
  end if;
end;
$$;

-- 2. Best effort on the provider's ACL, claimed as nothing.
-- Reaching a row still requires a policy, so these statements are a tidy-up, not the boundary. They are
-- attempted and any privilege error is reported and tolerated, because the migration role is not the
-- owner and a REVOKE or GRANT it issues may legitimately do nothing at all.
do $$
declare
  failed_state text;
  failed_message text;
begin
  begin
    execute 'revoke all on realtime.messages from anon, authenticated';
    execute 'grant select on realtime.messages to authenticated';
  exception
    when others then
      get stacked diagnostics failed_state = returned_sqlstate, failed_message = message_text;
      raise notice 'realtime.messages ACL left as Supabase set it (SQLSTATE %): %', failed_state, failed_message;
  end;
end;
$$;

-- 3. The private-topic policy, and no other.
-- Receive only. There is deliberately no insert policy: the worker publishes with server credentials.
do $$
declare
  failed_state text;
  failed_message text;
  extra text;
begin
  begin
    execute 'drop policy if exists realtime_private_topic_receive on realtime.messages';
    execute $p$
      create policy realtime_private_topic_receive on realtime.messages
        for select to authenticated
        using (public.can_join_realtime_topic(topic))
    $p$;
  exception
    when others then
      get stacked diagnostics failed_state = returned_sqlstate, failed_message = message_text;
      raise exception 'cannot define the private-topic policy on realtime.messages (SQLSTATE %): %', failed_state, failed_message
        using hint = 'Private-topic access stays defined in migrations. If this is a privilege error, the migration role lost a capability it had when 0014 was written.';
  end;

  select string_agg(format('%s (%s)', p.polname, p.polcmd), ', ' order by p.polname) into extra
    from pg_policy p
   where p.polrelid = 'realtime.messages'::regclass
     and p.polname <> 'realtime_private_topic_receive';

  if extra is not null then
    raise exception 'realtime.messages carries a policy this migration did not define: %', extra
      using hint = 'With row level security on, a policy is the only thing that opens the mailbox. A second policy can hand a client a topic it may not join, or let it publish.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table public.conversations enable row level security;
alter table public.conversation_participants enable row level security;
alter table public.messages enable row level security;
alter table public.message_attachments enable row level security;

create policy conversations_participant_read on public.conversations for select to authenticated
  using (public.is_conversation_participant(id));
create policy conversations_creator_insert on public.conversations for insert to authenticated
  with check (created_by = public.current_user_id());
create policy conversations_participant_update on public.conversations for update to authenticated
  using (public.is_conversation_participant(id))
  with check (public.is_conversation_participant(id));

create policy conversation_participants_read on public.conversation_participants for select to authenticated
  using (public.is_conversation_participant(conversation_id));
create policy conversation_participants_self_update on public.conversation_participants for update to authenticated
  using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id());

create policy messages_participant_read on public.messages for select to authenticated
  using (public.is_conversation_participant(conversation_id));
create policy messages_participant_insert on public.messages for insert to authenticated
  with check (
    sender_user_id = public.current_user_id()
    and public.is_conversation_participant(conversation_id)
    and not exists (select 1 from public.conversations c where c.id = conversation_id and c.closed_at is not null)
  );
create policy messages_sender_update on public.messages for update to authenticated
  using (sender_user_id = public.current_user_id())
  with check (sender_user_id = public.current_user_id());

create policy message_attachments_participant_read on public.message_attachments for select to authenticated
  using (exists (
    select 1 from public.messages m
    where m.id = message_id and public.is_conversation_participant(m.conversation_id)
  ));
create policy message_attachments_sender_insert on public.message_attachments for insert to authenticated
  with check (exists (
    select 1 from public.messages m
    where m.id = message_id and m.sender_user_id = public.current_user_id()
  ));

grant select, insert, update on public.conversations to authenticated;
grant select, update on public.conversation_participants to authenticated;
grant select, insert, update on public.messages to authenticated;
grant select, insert on public.message_attachments to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function
  public.is_conversation_participant(uuid, uuid),
  public.conversation_topic(uuid),
  public.user_topic(uuid),
  public.can_join_realtime_topic(text)
  to authenticated;

grant execute on function
  public.conversation_topic(uuid),
  public.user_topic(uuid)
  to app_system, app_worker;
